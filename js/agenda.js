import { clinicaState } from './state.js';
import { showToast, comEstadoDeCarregamento, escapeHTML, confirmarAcao, formatCurrency } from './Ferramentas.js';
import { db } from './firebase.js';
import { collection, addDoc, getDocs, doc, deleteDoc, updateDoc, query, where, runTransaction } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { criarNotificacao } from './notificacoes.js';
import { registrarAuditoria } from './auditoria.js';
import { valorDoProcedimentoParaProfissional } from './procedimentos.js';

console.info('[agenda.js] versão com escala por profissional carregada');
let agendamentoIdParaAtualizar = null;
let notificacaoIdEmResolucao = null;
let periodoAtual = 'dia';
let filtroStatusAtual = 'todos';
let pagamentoAdicionalConfirmado = false;
let datasEscalaPendentes = [];
let itensProcedimentoAgenda = [];
const buscasAgenda = new WeakMap();

const NOMES_MES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const NOMES_DIA_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

const META_STATUS = {
    agendado: { rotulo: 'Agendado', icone: 'fa-regular fa-clock' },
    confirmado: { rotulo: 'Confirmado', icone: 'fa-solid fa-check' },
    aguardando_atendimento: { rotulo: 'Na Espera', icone: 'fa-solid fa-couch' },
    concluido: { rotulo: 'Atendido', icone: 'fa-solid fa-flag-checkered' }
};

function parseDataLocal(isoDate) {
    const [ano, mes, dia] = isoDate.split('-').map(Number);
    return new Date(ano, mes - 1, dia);
}

function paraIsoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function obterDomingoDaSemana(d) {
    const domingo = new Date(d);
    domingo.setDate(domingo.getDate() - domingo.getDay());
    return domingo;
}

function obterBloqueio(profId, data, hora) {
    return clinicaState.agenda.bloqueios.find(b => {
        if (String(b.profId) !== String(profId) || b.data !== data) return false;
        if (b.tipo === 'dia_inteiro') return true;
        return hora >= b.horaInicio && hora <= b.horaFim;
    });
}

function obterBloqueioNoIntervalo(profId, data, inicioMinutos, fimMinutos) {
    return clinicaState.agenda.bloqueios.find(b => {
        if (String(b.profId) !== String(profId) || b.data !== data) return false;
        if (b.tipo === 'dia_inteiro') return true;
        const inicioBloqueio = minutosDoHorario(b.horaInicio);
        const fimBloqueio = minutosDoHorario(b.horaFim);
        return inicioBloqueio !== null && fimBloqueio !== null
            && inicioBloqueio < fimMinutos && fimBloqueio > inicioMinutos;
    });
}

function montarDadosFinanceiroDoAgendamento(agendamento, formaPagamento, valorPago) {
    const valorBruto = parseFloat((valorPago ?? agendamento.valorAtendimento ?? 0).toString().replace(/\./g, '').replace(',', '.'));
    if (!valorBruto || valorBruto <= 0) return null;

    const profissional = clinicaState.profissionais.find(p => String(p.id) === String(agendamento.profId));
    const hoje = new Date().toISOString().split('T')[0];
    const agoraIso = new Date().toISOString();

    return {
        tipo: 'Receita',
        vinculo: `Consulta de ${agendamento.pacNome} - ${agendamento.procedimentoNome || agendamento.tipo || 'Consulta'}`,
        pagamento: formaPagamento,
        status: 'Recebido/Pago',
        competencia: hoje,
        caixa: hoje,
        valor: valorBruto,
        profissionalId: agendamento.profId || null,
        profissionalNome: profissional ? profissional.nome : null,
        clinicaId: clinicaState.sessao.clinicaId,
        origem: 'agendamento',
        agendamentoId: agendamento.id || null,
        pacienteId: agendamento.pacId || null,
        pacienteNome: agendamento.pacNome || null,
        procedimentoId: agendamento.procedimentoId || null,
        procedimentoNome: agendamento.procedimentoNome || null,
        itens: agendamento.itens || [],
        dataConsulta: agendamento.data || null,
        horaConsulta: agendamento.hora || null,
        pagoEm: agoraIso,
        pagoPor: clinicaState.sessao.nome || null
    };
}

async function confirmarPagamentoTransacional(idAgendamento, dadosAgendamento, dadosFinanceiro, permitirMesmoJaPago) {
    const refAgendamento = doc(db, "agendamentos", idAgendamento);
    const refFinanceiroNovo = doc(collection(db, "financeiro"));

    await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(refAgendamento);
        if (!snap.exists()) throw new Error('AGENDAMENTO_NAO_ENCONTRADO');

        const estadoAtualNoBanco = snap.data();
        if (estadoAtualNoBanco.statusPagamento === 'pago' && !permitirMesmoJaPago) {
            throw new Error('JA_PAGO_NO_BANCO');
        }

        transaction.update(refAgendamento, dadosAgendamento);
        transaction.set(refFinanceiroNovo, dadosFinanceiro);
    });
}

// Avança o status do paciente com 1 clique (sem misturar com cobrança forçada)
async function alterarStatusConsultaRapido(idAgendamento, novoStatus) {
    const agendamento = clinicaState.agenda.agendamentos.find(a => String(a.id) === String(idAgendamento));
    if (!agendamento) return;

    const valorConsulta = Number(agendamento.valorAtendimento || 0);
    const jaEstaPaga = agendamento.statusPagamento === 'pago';
    const proximoStatusPagamento = valorConsulta > 0 ? (jaEstaPaga ? 'pago' : 'pendente') : 'nao_aplica';

    try {
        await updateDoc(doc(db, "agendamentos", idAgendamento), {
            status: novoStatus,
            statusPagamento: proximoStatusPagamento
        });

        agendamento.status = novoStatus;
        agendamento.statusPagamento = proximoStatusPagamento;

        const mensagens = {
            agendado: `Status de ${agendamento.pacNome} voltou para Agendado.`,
            confirmado: `Presença de ${agendamento.pacNome} confirmada!`,
            aguardando_atendimento: `Check-in feito! ${agendamento.pacNome} entrou na Fila de Atendimento do profissional.`,
            concluido: `Atendimento de ${agendamento.pacNome} marcado como concluído!`
        };
        showToast(mensagens[novoStatus] || 'Status atualizado!', 'success');

        if (novoStatus === 'concluido' && valorConsulta > 0 && !jaEstaPaga) {
            await criarNotificacao({
                tipo: 'pagamento_pendente',
                titulo: 'Confirmar pagamento',
                mensagem: `A consulta de ${agendamento.pacNome} (${agendamento.procedimentoNome || agendamento.tipo || 'Consulta'}) foi concluída e aguarda baixa no caixa.`,
                pacienteId: agendamento.pacId,
                pacienteNome: agendamento.pacNome,
                agendamentoId: idAgendamento
            });
        }

        atualizarAgenda();
    } catch (error) {
        console.error("Erro ao atualizar status rápido:", error);
        showToast('Não foi possível atualizar o status da consulta.', 'error');
    }
}

async function enviarTriagemParaMedico(idAgendamento) {
    const agendamento = clinicaState.agenda.agendamentos.find(a => String(a.id) === String(idAgendamento));
    if (!agendamento) return;

    try {
        const novos = {
            status: 'aguardando_atendimento',
            triagemPronta: true,
            triagemEm: new Date().toISOString(),
            triagemPor: clinicaState.sessao.nome || 'Triagem'
        };
        await updateDoc(doc(db, "agendamentos", idAgendamento), novos);
        Object.assign(agendamento, novos);
        showToast(`Triagem de ${agendamento.pacNome} finalizada e enviada para o médico!`, 'success');
        atualizarAgenda();
    } catch (error) {
        console.error('Erro ao enviar triagem:', error);
        showToast('Não foi possível atualizar o status da triagem.', 'error');
    }
}

export async function abrirModalPagamento(idAgendamento, notificacaoId = null) {
    const modal = document.getElementById('modal-confirmar-agendamento');
    const form = document.getElementById('form-confirmar-agendamento');
    const agendamento = clinicaState.agenda.agendamentos.find(a => String(a.id) === String(idAgendamento));

    if (!modal || !form || !agendamento) return;

    pagamentoAdicionalConfirmado = false;

    if (agendamento.statusPagamento === 'pago') {
        const dataPagamento = agendamento.pagoEm
            ? new Date(agendamento.pagoEm).toLocaleString('pt-BR')
            : 'data não registrada';
        const valorJaPago = formatCurrency(Number(agendamento.valorAtendimento || 0));
        const formaJaPaga = agendamento.observacaoConfirmacao?.formaPagamento || agendamento.pagamento || '';

        const continuar = await confirmarAcao(
            `Esta consulta já está marcada como PAGA: ${valorJaPago}${formaJaPaga ? ' via ' + formaJaPaga : ''}, em ${dataPagamento}${agendamento.pagoPor ? ' (confirmado por ' + agendamento.pagoPor + ')' : ''}. Continuar aqui vai criar um NOVO lançamento no Livro Caixa.`,
            { titulo: 'Consulta já paga', textoConfirmar: 'Registrar pagamento adicional', perigoso: true }
        );

        if (!continuar) return;
        pagamentoAdicionalConfirmado = true;
    }

    agendamentoIdParaAtualizar = idAgendamento;
    notificacaoIdEmResolucao = notificacaoId;
    form.reset();

    const profissional = clinicaState.profissionais.find(p => String(p.id) === String(agendamento.profId));
    const nomeAtendimento = agendamento.procedimentoNome || agendamento.tipo || 'Consulta';
    const dataFormatada = agendamento.data ? `${agendamento.data.split('-').reverse().join('/')} às ${agendamento.hora || ''}` : '-';

    const setTexto = (id, texto) => { const el = document.getElementById(id); if (el) el.textContent = texto; };
    setTexto('pagamento-resumo-paciente', agendamento.pacNome || '-');
    setTexto('pagamento-resumo-atendimento', nomeAtendimento);
    setTexto('pagamento-resumo-profissional', profissional ? profissional.nome : '-');
    setTexto('pagamento-resumo-data', dataFormatada);

    const avisoDuplicado = document.getElementById('pagamento-aviso-duplicado');
    const avisoDuplicadoTexto = document.getElementById('pagamento-aviso-duplicado-texto');
    const btnSubmit = document.getElementById('btn-confirmar-pagamento-submit');
    const modalPagamentoContent = modal.querySelector('.pagamento-modal');
    const checkVerificacao = document.getElementById('pagamento-verificacao-confirmada');

    if (avisoDuplicado) avisoDuplicado.style.display = pagamentoAdicionalConfirmado ? 'flex' : 'none';
    if (avisoDuplicadoTexto && pagamentoAdicionalConfirmado) {
        avisoDuplicadoTexto.textContent = 'Você está registrando um pagamento ADICIONAL para uma consulta que já constava como paga.';
    }
    if (modalPagamentoContent) modalPagamentoContent.classList.toggle('pagamento-modo-adicional', pagamentoAdicionalConfirmado);
    if (btnSubmit) {
        btnSubmit.innerHTML = pagamentoAdicionalConfirmado
            ? '<i class="fa-solid fa-triangle-exclamation"></i> Confirmar Pagamento Adicional'
            : '<i class="fa-solid fa-check"></i> Confirmar Pagamento';
        btnSubmit.disabled = true;
    }
    if (checkVerificacao) checkVerificacao.checked = false;

    const valorBase = Number((agendamento.valorAtendimento ?? 0));
    const inputValor = document.getElementById('pagamento-valor');
    if (inputValor) {
        inputValor.value = valorBase.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    const selectPagamento = document.getElementById('pagamento-forma');
    if (selectPagamento) {
        selectPagamento.value = 'Pix';
        selectPagamento.dispatchEvent(new Event('change'));
    }

    modal.classList.add('active');
}

function renderizarItensProcedimentoAgenda() {
    const container = document.getElementById('agenda-itens-selecionados');
    const campoValor = document.getElementById('agenda-valor');
    if (!container) return;

    if (itensProcedimentoAgenda.length === 0) {
        container.style.display = 'none';
        container.innerHTML = '';
        if (campoValor) campoValor.value = formatCurrency(obterValorProcedimentoSelecionado());
        return;
    }

    container.style.display = 'flex';
    container.innerHTML = itensProcedimentoAgenda.map((item, idx) => `
        <span class="anexo-chip">
            <span>${escapeHTML(item.nome)} (<strong>${formatCurrency(item.valor)}</strong>)</span>
            <button type="button" class="btn-remover-item-agenda" data-idx="${idx}" data-sem-cooldown title="Remover" style="background:none; border:none; color:#dc3545; cursor:pointer; margin-left:6px;">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </span>
    `).join('');

    const total = itensProcedimentoAgenda.reduce((soma, it) => soma + Number(it.valor || 0), 0);
    if (campoValor) campoValor.value = formatCurrency(total);
}

function adicionarItemProcedimentoAtual() {
    const tipoAtendimento = document.getElementById('agenda-tipo')?.value;
    const selectProcedimento = document.getElementById('agenda-procedimento');
    const profId = document.getElementById('agenda-profissional')?.value || '';
    if (!selectProcedimento || !selectProcedimento.value) {
        return showToast('Selecione um procedimento antes de adicionar.', 'warning');
    }

    const itemId = selectProcedimento.value;
    const isPacote = tipoAtendimento === 'pacote';
    const obj = isPacote
        ? clinicaState.pacotes.find(p => String(p.id) === String(itemId))
        : clinicaState.procedimentos.find(p => String(p.id) === String(itemId));

    if (!obj) return;

    const valor = isPacote
        ? Number(obj.valorEspecie ?? obj.valorFechado ?? 0)
        : valorDoProcedimentoParaProfissional(itemId, profId, 'Dinheiro');

    itensProcedimentoAgenda.push({
        id: String(obj.id),
        nome: obj.nome,
        valor
    });

    renderizarItensProcedimentoAgenda();
}

function obterValorProcedimentoSelecionado() {
    const tipoAtendimento = document.getElementById('agenda-tipo')?.value;
    const selectProcedimento = document.getElementById('agenda-procedimento');
    const profissionalId = document.getElementById('agenda-profissional')?.value;

    if (!selectProcedimento || !profissionalId) return 0;
    const itemId = selectProcedimento.value;
    if (!itemId) return 0;

    if (tipoAtendimento === 'pacote') {
        const pac = clinicaState.pacotes.find(p => String(p.id) === String(itemId));
        return pac ? Number(pac.valorEspecie ?? pac.valorFechado ?? 0) : 0;
    }

    return valorDoProcedimentoParaProfissional(itemId, profissionalId);
}

function atualizarVisualizacaoProcedimento() {
    const tipoAtendimento = document.getElementById('agenda-tipo')?.value;
    const selectProcedimento = document.getElementById('agenda-procedimento');
    const campoValor = document.getElementById('agenda-valor');
    const grupoProcedimento = document.getElementById('grupo-agenda-procedimento');

    if (!selectProcedimento || !campoValor || !grupoProcedimento) return;

    const isRevisao = tipoAtendimento === 'revisao';
    const isAvulso = tipoAtendimento === 'procedimento_avulso';
    const isPacote = tipoAtendimento === 'pacote';

    grupoProcedimento.style.display = (isAvulso || isPacote) ? 'block' : 'none';
    selectProcedimento.disabled = !(isAvulso || isPacote);

    if (isRevisao) {
        itensProcedimentoAgenda = [];
        renderizarItensProcedimentoAgenda();
        campoValor.value = 'R$ 0,00 (Revisão sem custo)';
        return;
    }

    if (!selectProcedimento.value) {
        if (isAvulso && clinicaState.procedimentos.length > 0) {
            selectProcedimento.value = String(clinicaState.procedimentos[0].id);
        } else if (isPacote && clinicaState.pacotes.length > 0) {
            selectProcedimento.value = String(clinicaState.pacotes[0].id);
        }
    }

    const valor = obterValorProcedimentoSelecionado();
    campoValor.value = isPacote ? `${formatCurrency(valor)} (Pacote)` : formatCurrency(valor);
}

function adicionarBuscaAoSelect(select, descricao) {
    if (!select) return null;

    // Se já tem busca acoplada, apenas ressincroniza com as novas opções do <select>
    if (buscasAgenda.has(select)) {
        const api = buscasAgenda.get(select);
        api.sincronizar();
        return api.input;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'agenda-search-control';

    const inputWrap = document.createElement('div');
    inputWrap.className = 'agenda-search-input-wrap';

    const icone = document.createElement('i');
    icone.className = 'fa-solid fa-magnifying-glass agenda-search-icon';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input-premium agenda-search-input';
    input.placeholder = `Digite para buscar ${descricao}...`;
    input.autocomplete = 'off';

    const btnLimpar = document.createElement('button');
    btnLimpar.type = 'button';
    btnLimpar.className = 'agenda-search-clear';
    btnLimpar.setAttribute('data-sem-cooldown', 'true');
    btnLimpar.title = 'Limpar seleção';
    btnLimpar.innerHTML = '<i class="fa-solid fa-xmark"></i>';

    const resultados = document.createElement('div');
    resultados.className = 'agenda-search-results';
    resultados.hidden = true;

    const parent = select.parentElement;
    if (!parent) return null;

    inputWrap.append(icone, input, btnLimpar);
    wrapper.append(inputWrap, resultados);
    parent.insertBefore(wrapper, select);
    wrapper.appendChild(select);

    select.classList.add('agenda-search-source');
    select.required = false;

    let indiceDestacado = -1;

    const normalizar = (txt) => String(txt || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

    const obterOpcoesValidas = () => Array.from(select.options).filter(o => o.value !== '');

    const atualizarBotaoLimpar = () => {
        btnLimpar.style.display = (input.value && !select.disabled) ? 'inline-flex' : 'none';
    };

    const sincronizar = () => {
        const opSelecionada = Array.from(select.options).find(o => o.value === select.value && o.value !== '');
        input.value = opSelecionada ? opSelecionada.textContent.trim() : '';
        input.disabled = select.disabled;
        wrapper.style.display = select.style.display === 'none' ? 'none' : '';
        atualizarBotaoLimpar();
    };

    const fecharLista = () => {
        resultados.hidden = true;
        indiceDestacado = -1;
        // Se o usuário digitou algo mas saiu sem escolher, restaura o texto do item válido atual
        const opAtual = Array.from(select.options).find(o => o.value === select.value && o.value !== '');
        if (opAtual) {
            input.value = opAtual.textContent.trim();
        } else {
            input.value = '';
        }
        atualizarBotaoLimpar();
    };

    const escolherOpcao = (option) => {
        if (!option) return;
        select.value = option.value;
        input.value = option.textContent.trim();
        resultados.hidden = true;
        indiceDestacado = -1;
        atualizarBotaoLimpar();
        select.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const destacarItem = (botoes, novoIndice) => {
        if (!botoes.length) return;
        indiceDestacado = (novoIndice + botoes.length) % botoes.length;
        botoes.forEach((b, i) => {
            b.classList.toggle('is-highlighted', i === indiceDestacado);
            if (i === indiceDestacado) b.scrollIntoView({ block: 'nearest' });
        });
    };

    // se mostrarTudo = true, exibe todas as opções ao focar no campo (mesmo já preenchido)
    const renderizar = (mostrarTudo = false) => {
        if (select.disabled) return;
        const termo = mostrarTudo ? '' : normalizar(input.value.trim());
        const opcoes = obterOpcoesValidas().filter(o => normalizar(o.textContent).includes(termo));

        resultados.replaceChildren();
        indiceDestacado = -1;

        if (opcoes.length === 0) {
            const vazio = document.createElement('div');
            vazio.className = 'agenda-search-empty';
            vazio.textContent = `Nenhum(a) ${descricao} encontrado(a).`;
            resultados.appendChild(vazio);
        } else {
            opcoes.forEach((option, idx) => {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'agenda-search-option';
                item.setAttribute('data-sem-cooldown', 'true'); // Evita trava do main.js!
                item.textContent = option.textContent.trim();

                if (idx === 0 && termo !== '') {
                    item.classList.add('is-highlighted');
                    indiceDestacado = 0;
                }

                // mousedown dispara ANTES do blur do input, garantindo clique 100% confiável
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    escolherOpcao(option);
                });
                resultados.appendChild(item);
            });
        }
        resultados.hidden = false;
    };

    input.addEventListener('focus', () => {
        if (select.disabled) return;
        input.select();
        renderizar(true); // Abre mostrando a lista completa para facilitar!
    });

    input.addEventListener('click', () => {
        if (resultados.hidden && !select.disabled) renderizar(true);
    });

    input.addEventListener('input', () => {
        atualizarBotaoLimpar();
        renderizar(false);
    });

    input.addEventListener('keydown', (e) => {
        const botoes = Array.from(resultados.querySelectorAll('.agenda-search-option'));
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (resultados.hidden) renderizar(true);
            else destacarItem(botoes, indiceDestacado + 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (!resultados.hidden) destacarItem(botoes, indiceDestacado - 1);
        } else if (e.key === 'Enter') {
            if (!resultados.hidden && botoes.length > 0) {
                e.preventDefault();
                const alvo = botoes[indiceDestacado >= 0 ? indiceDestacado : 0];
                alvo?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            }
        } else if (e.key === 'Escape') {
            fecharLista();
        }
    });

    btnLimpar.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (select.disabled) return;
        input.value = '';
        select.value = '';
        atualizarBotaoLimpar();
        input.focus();
        renderizar(true);
    });

    document.addEventListener('mousedown', (e) => {
        if (!wrapper.contains(e.target)) {
            fecharLista();
        }
    });

    select.addEventListener('change', sincronizar);

    const api = { sincronizar, input, wrapper };
    buscasAgenda.set(select, api);
    sincronizar();
    return input;
}

function popularSelectProcedimentos() {
    const selectProcedimento = document.getElementById('agenda-procedimento');
    const tipoAtendimento = document.getElementById('agenda-tipo')?.value || 'procedimento_avulso';
    const grupoProcedimento = document.getElementById('grupo-agenda-procedimento');
    if (!selectProcedimento) return;

    const profId = document.getElementById('agenda-profissional')?.value || '';
    if (tipoAtendimento === 'pacote') {
        if (grupoProcedimento) grupoProcedimento.style.display = 'block';
        selectProcedimento.disabled = false;
        const pacotesDoProf = clinicaState.pacotes.filter(p => !p.profissionalPadraoId || String(p.profissionalPadraoId) === String(profId));
        const listaPac = pacotesDoProf.length > 0 ? pacotesDoProf : clinicaState.pacotes;

        selectProcedimento.innerHTML = '<option value="">Selecione o pacote...</option>' +
            listaPac.map(pac => `<option value="${pac.id}">📦 ${escapeHTML(pac.nome)} (Espécie: ${formatCurrency(pac.valorEspecie ?? pac.valorFechado)} | Pix/Cartão: ${formatCurrency(pac.valorCartaoPix ?? pac.valorFechado)})</option>`).join('');
        adicionarBuscaAoSelect(selectProcedimento, 'pacote');
        return;
    }

    const exclusivosDoProf = clinicaState.procedimentos.filter(p => String(p.profissionalPadraoId) === String(profId));
    const gerais = clinicaState.procedimentos.filter(p => !p.profissionalPadraoId);
    const listaFinal = exclusivosDoProf.length > 0 ? [...exclusivosDoProf, ...gerais] : clinicaState.procedimentos;

    selectProcedimento.innerHTML = '<option value="">Selecione a consulta, exame ou procedimento...</option>' +
        listaFinal.map(proc => {
            const vEsp = valorDoProcedimentoParaProfissional(proc.id, profId, 'Dinheiro');
            const vPix = valorDoProcedimentoParaProfissional(proc.id, profId, 'Pix');
            const icone = proc.tipoItem === 'Exame' ? '🔬' : proc.tipoItem === 'Consulta' ? '🩺' : proc.tipoItem === 'Avaliação' ? '📋' : '💉';
            return `<option value="${proc.id}">${icone} ${escapeHTML(proc.nome)} — Din: ${formatCurrency(vEsp)} | Pix/Cart: ${formatCurrency(vPix)}</option>`;
        }).join('');

    if (listaFinal.length > 0) {
        selectProcedimento.value = String(listaFinal[0].id);
    }
    adicionarBuscaAoSelect(selectProcedimento, 'procedimento');
}

export function verificarAlertasAgendamento() {}

// Renderiza a barra de resumo e filtros rápidos da Recepção no topo da Agenda
function renderizarBarraResumoRecepcao(dataSelecionada) {
    const secaoAgenda = document.getElementById('agenda');
    const viewDia = document.getElementById('agenda-view-dia');
    if (!secaoAgenda || !viewDia) return;

    let barra = document.getElementById('agenda-status-bar');
    if (!barra) {
        barra = document.createElement('div');
        barra.id = 'agenda-status-bar';
        barra.className = 'agenda-status-bar';
        viewDia.parentNode.insertBefore(barra, viewDia);

        barra.addEventListener('click', (e) => {
            const pill = e.target.closest('.agenda-filter-pill');
            if (!pill) return;
            filtroStatusAtual = pill.getAttribute('data-status-filter') || 'todos';
            atualizarAgenda();
        });
    }

    if (periodoAtual !== 'dia') {
        barra.style.display = 'none';
        return;
    }
    barra.style.display = 'flex';

    const filtroProf = document.getElementById('filtro-profissional')?.value || 'todos';
    const doDia = agendamentosPermitidos(filtroProf).filter(a => a.data === dataSelecionada);

    const contagem = {
        todos: doDia.length,
        agendado: doDia.filter(a => (a.status || 'agendado') === 'agendado').length,
        confirmado: doDia.filter(a => a.status === 'confirmado').length,
        aguardando_atendimento: doDia.filter(a => a.status === 'aguardando_atendimento').length,
        concluido: doDia.filter(a => a.status === 'concluido').length
    };

    const opcoes = [
        { chave: 'todos', icone: 'fa-solid fa-layer-group', texto: 'Todos do Dia' },
        { chave: 'agendado', icone: 'fa-regular fa-clock', texto: 'A Confirmar' },
        { chave: 'confirmado', icone: 'fa-solid fa-check', texto: 'Confirmados' },
        { chave: 'aguardando_atendimento', icone: 'fa-solid fa-user-clock', texto: 'Na Sala de Espera' },
        { chave: 'concluido', icone: 'fa-solid fa-circle-check', texto: 'Concluídos' }
    ];

    barra.innerHTML = opcoes.map(op => `
        <button type="button" class="agenda-filter-pill ${filtroStatusAtual === op.chave ? 'active' : ''}" data-status-filter="${op.chave}">
            <i class="${op.icone}"></i> ${op.texto}
            <span class="pill-count">${contagem[op.chave]}</span>
        </button>
    `).join('');
}

// Quem o usuário logado pode ver na agenda.
//  - admin / recepção: todos os profissionais
//  - Doutor(a): a própria agenda + as agendas vinculadas ao seu usuário
//    (campo `profissionaisPermitidos` em /usuarios/{uid}, lista de ids de profissionais;
//    usado pelo assistente de triagem para enxergar a agenda do médico sem duplicar agendamentos)
function profissionaisDoUsuario() {
    if (clinicaState.sessao.perfil !== 'Doutor(a)') return clinicaState.profissionais;
    const nomeSessao = String(clinicaState.sessao.nome || '').trim().toLowerCase();
    const vinculados = new Set(
        (Array.isArray(clinicaState.sessao.profissionaisPermitidos) ? clinicaState.sessao.profissionaisPermitidos : []).map(String)
    );
    return clinicaState.profissionais.filter(p =>
        String(p.nome || '').trim().toLowerCase() === nomeSessao || vinculados.has(String(p.id))
    );
}

function profissionaisPermitidosNaAgenda() {
    return profissionaisDoUsuario();
}

function obterConfiguracaoEscala(profissional) {
    const configSalva = profissional?.agendaConfig;
    if (!configSalva) {
        return {
            frequencia: 'semanal',
            intervalo: 40,
            diasSemana: [2, 3, 4, 5],
            datas: [],
            manhaInicio: '08:40',
            manhaFim: '12:00',
            tardeInicio: '14:00',
            tardeFim: '17:20'
        };
    }

    return {
        frequencia: configSalva.frequencia === 'mensal' ? 'mensal' : 'semanal',
        intervalo: Number(configSalva.intervalo) || 40,
        diasSemana: Array.isArray(configSalva.diasSemana) ? configSalva.diasSemana.map(Number) : [],
        datas: Array.isArray(configSalva.datas) ? [...new Set(configSalva.datas)].sort() : [],
        manhaInicio: configSalva.manhaInicio || '',
        manhaFim: configSalva.manhaFim || '',
        tardeInicio: configSalva.tardeInicio || '',
        tardeFim: configSalva.tardeFim || ''
    };
}

function preencherFormEscala(profissional) {
    const config = obterConfiguracaoEscala(profissional);
    document.getElementById('escala-tipo-frequencia').value = config.frequencia;
    document.getElementById('escala-intervalo').value = String(config.intervalo);
    document.getElementById('escala-manha-inicio').value = config.manhaInicio;
    document.getElementById('escala-manha-fim').value = config.manhaFim;
    document.getElementById('escala-tarde-inicio').value = config.tardeInicio;
    document.getElementById('escala-tarde-fim').value = config.tardeFim;
    document.querySelectorAll('input[name="escala-dia-sem"]').forEach((checkbox) => {
        checkbox.checked = config.diasSemana.includes(Number(checkbox.value));
    });
    datasEscalaPendentes = config.datas;
    renderizarChipsDatasEscala();
    atualizarTipoFrequenciaEscala();
}

function renderizarChipsDatasEscala() {
    const container = document.getElementById('escala-datas-chips');
    container.innerHTML = datasEscalaPendentes.length
        ? datasEscalaPendentes.map(data => `
            <span class="anexo-chip">
                ${escapeHTML(data.split('-').reverse().join('/'))}
                <button type="button" class="btn-remover-data-escala" data-data="${escapeHTML(data)}" aria-label="Remover data ${escapeHTML(data)}">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </span>
        `).join('')
        : '<small>Nenhuma data incluída.</small>';
}

function atualizarTipoFrequenciaEscala() {
    const mensal = document.getElementById('escala-tipo-frequencia').value === 'mensal';
    document.getElementById('escala-bloco-semanal').hidden = mensal;
    document.getElementById('escala-bloco-mensal').hidden = !mensal;
}

function minutosDoHorario(horario) {
    if (!horario || !/^\d{2}:\d{2}$/.test(horario)) return null;
    const [hora, minuto] = horario.split(':').map(Number);
    return hora * 60 + minuto;
}

function horarioDeMinutos(minutos) {
    return `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;
}

function obterTurnosEscala(config) {
    return [
        { nome: 'Manhã', inicio: config.manhaInicio, fim: config.manhaFim },
        { nome: 'Tarde', inicio: config.tardeInicio, fim: config.tardeFim }
    ].filter(turno => turno.inicio && turno.fim);
}

function dataEstaNaEscala(config, data) {
    if (config.frequencia === 'mensal') return config.datas.includes(data);
    return config.diasSemana.includes(parseDataLocal(data).getDay());
}

// ====== ESCALA COMO FONTE DA VERDADE DA AGENDA ======
const HORARIOS_PADRAO = ['08:00', '09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

// Horários (HH:MM) em que o profissional atende na data, conforme a escala.
//  - null  => escala nunca configurada (mantém o comportamento antigo, de hora em hora)
//  - []    => tem escala, mas NÃO atende nesta data
function obterHorariosDaEscala(profissional, data) {
    if (!profissional || !profissional.agendaConfig) return null;
    const config = obterConfiguracaoEscala(profissional);
    if (!data || !dataEstaNaEscala(config, data)) return [];

    const horarios = [];
    obterTurnosEscala(config).forEach((turno) => {
        const inicio = minutosDoHorario(turno.inicio);
        const fim = minutosDoHorario(turno.fim);
        if (inicio === null || fim === null) return;
        for (let minuto = inicio; minuto + config.intervalo <= fim; minuto += config.intervalo) {
            horarios.push(horarioDeMinutos(minuto));
        }
    });
    return horarios;
}

function proximasDatasDaEscala(profissional, aPartirDe, maximo = 3) {
    if (!profissional || !profissional.agendaConfig) return [];
    const config = obterConfiguracaoEscala(profissional);
    if (config.frequencia === 'mensal') {
        return config.datas.filter(d => d >= aPartirDe).slice(0, maximo);
    }
    const datas = [];
    const cursor = parseDataLocal(aPartirDe);
    for (let i = 0; i < 90 && datas.length < maximo; i += 1) {
        if (config.diasSemana.includes(cursor.getDay())) datas.push(paraIsoDate(cursor));
        cursor.setDate(cursor.getDate() + 1);
    }
    return datas;
}

function dataBR(iso) {
    return iso ? iso.split('-').reverse().join('/') : '';
}

// Preenche o <select> de horário do "Novo Agendamento" só com as vagas
// da escala do profissional escolhido na data escolhida.
function atualizarHorariosDoAgendamento(horaPreferida = '') {
    const selectHora = document.getElementById('agenda-hora');
    const aviso = document.getElementById('agenda-aviso-escala');
    if (!selectHora) return;

    const profId = document.getElementById('agenda-profissional').value;
    const data = document.getElementById('agenda-data').value;
    const prof = clinicaState.profissionais.find(p => String(p.id) === String(profId));
    const anterior = horaPreferida || selectHora.value;

    let horarios = obterHorariosDaEscala(prof, data);
    let mensagem = '';
    if (horarios === null) {
        horarios = HORARIOS_PADRAO;
        if (prof) mensagem = 'A escala deste profissional ainda não foi configurada (usando horários de 1 em 1 hora). Configure em Agenda > Disponibilidade / Escala.';
    } else if (horarios.length === 0) {
        const proximas = proximasDatasDaEscala(prof, data || paraIsoDate(new Date()));
        mensagem = `${prof.nome} não atende em ${dataBR(data)}.` + (proximas.length ? ` Próximas datas: ${proximas.map(dataBR).join(', ')}.` : '');
    }

    const indisponivel = (h) => {
        const ocupado = clinicaState.agenda.agendamentos.some(a =>
            String(a.profId) === String(profId) && a.data === data && a.hora === h && a.status !== 'cancelado');
        if (ocupado) return 'ocupado';
        if (obterBloqueio(profId, data, h)) return 'bloqueado';
        return '';
    };

    selectHora.innerHTML = horarios.length
        ? horarios.map(h => {
            const motivo = indisponivel(h);
            return `<option value="${h}"${motivo ? ' disabled' : ''}>${h}${motivo ? ` (${motivo})` : ''}</option>`;
        }).join('')
        : '<option value="">Sem horários nesta data</option>';

    const livres = horarios.filter(h => !indisponivel(h));
    selectHora.value = livres.includes(anterior) ? anterior : (livres[0] || '');

    if (aviso) {
        aviso.textContent = mensagem;
        aviso.hidden = !mensagem;
    }
    atualizarDisponibilidadeSalas();
}

function renderizarAtalhosDisponibilidade(config) {
    const container = document.getElementById('disp-atalhos-datas');
    const inputData = document.getElementById('disp-data-consulta');
    const hoje = paraIsoDate(new Date());
    let datas = [];

    if (config.frequencia === 'mensal') {
        datas = config.datas.filter(data => data >= hoje).slice(0, 5);
    } else {
        const data = parseDataLocal(hoje);
        for (let i = 0; i < 45 && datas.length < 5; i += 1) {
            const iso = paraIsoDate(data);
            if (config.diasSemana.includes(data.getDay())) datas.push(iso);
            data.setDate(data.getDate() + 1);
        }
    }

    container.innerHTML = datas.map(data => `
        <button type="button" class="btn-secondary btn-compact" data-disp-data="${escapeHTML(data)}">
            ${escapeHTML(data.split('-').reverse().join('/'))}
        </button>
    `).join('');
    container.querySelectorAll('[data-disp-data]').forEach((button) => {
        button.addEventListener('click', () => {
            inputData.value = button.dataset.dispData;
            renderizarDisponibilidade();
        });
    });
}

function renderizarDisponibilidade() {
    const selectProfissional = document.getElementById('disp-profissional');
    const profissional = clinicaState.profissionais.find(p => String(p.id) === String(selectProfissional.value));
    const data = document.getElementById('disp-data-consulta').value;
    const resumo = document.getElementById('disp-resumo-escala');
    const grade = document.getElementById('disp-grade-vagas');

    if (!profissional) {
        resumo.textContent = 'Nenhum profissional disponível para esta conta.';
        grade.replaceChildren();
        document.getElementById('disp-atalhos-datas').replaceChildren();
        return;
    }

    const config = obterConfiguracaoEscala(profissional);
    const frequencia = config.frequencia === 'mensal' ? 'Datas específicas' : 'Semanal';
    if (!profissional.agendaConfig) {
        resumo.textContent = 'A escala deste profissional ainda não foi configurada. Acesse “Configurar Dias e Intervalos” para definir os horários.';
        grade.replaceChildren();
        renderizarAtalhosDisponibilidade(config);
        return;
    }

    resumo.textContent = `${frequencia} • Intervalos de ${config.intervalo} minutos • ${obterTurnosEscala(config).map(t => `${t.nome}: ${t.inicio}–${t.fim}`).join(' | ')}`;
    renderizarAtalhosDisponibilidade(config);

    if (!data || !dataEstaNaEscala(config, data)) {
        grade.innerHTML = '<div class="highlight-box full-width">Este profissional não atende na data selecionada.</div>';
        return;
    }

    const vagas = [];
    obterTurnosEscala(config).forEach((turno) => {
        const inicio = minutosDoHorario(turno.inicio);
        const fim = minutosDoHorario(turno.fim);
        if (inicio === null || fim === null) return;

        for (let minuto = inicio; minuto + config.intervalo <= fim; minuto += config.intervalo) {
            const hora = horarioDeMinutos(minuto);
            const fimVagaMinutos = minuto + config.intervalo;
            const agendamento = clinicaState.agenda.agendamentos.find(a =>
                String(a.profId) === String(profissional.id)
                && a.data === data
                && a.status !== 'cancelado'
                && minutosDoHorario(a.hora) !== null
                && minutosDoHorario(a.hora) < fimVagaMinutos
                && minutosDoHorario(a.hora) + config.intervalo > minuto
            );
            const bloqueio = obterBloqueioNoIntervalo(profissional.id, data, minuto, fimVagaMinutos);
            const estado = bloqueio ? 'bloqueado' : agendamento ? 'ocupado' : 'livre';
            const textoEstado = bloqueio ? 'Bloqueado' : agendamento ? 'Ocupado' : 'Livre';
            const tag = estado === 'livre' ? 'button' : 'div';
            const atributos = estado === 'livre' ? `type="button" data-disp-hora="${hora}"` : '';
            vagas.push(`
                <${tag} class="disponibilidade-slot ${estado}" ${atributos}>
                    <strong>${hora}</strong>
                    <span>${turno.nome} · ${textoEstado}</span>
                </${tag}>
            `);
        }
    });

    grade.innerHTML = vagas.length
        ? vagas.join('')
        : '<div class="highlight-box full-width">Não há horários configurados para esta data.</div>';
    grade.querySelectorAll('[data-disp-hora]').forEach((button) => {
        button.addEventListener('click', () => {
            document.getElementById('modal-disponibilidade').classList.remove('active');
            abrirModalAgendamento(button.dataset.dispHora, profissional.id, data);
        });
    });
}

function abrirModalDisponibilidade() {
    const modal = document.getElementById('modal-disponibilidade');
    const select = document.getElementById('disp-profissional');
    const profissionais = profissionaisPermitidosNaAgenda();
    const filtro = document.getElementById('filtro-profissional').value;
    const profissionalInicial = profissionais.find(p => String(p.id) === String(filtro)) || profissionais[0];

    select.innerHTML = profissionais.map(p =>
        `<option value="${escapeHTML(p.id)}">${escapeHTML(p.nome)} (${escapeHTML(p.especialidade || '')})</option>`
    ).join('');
    if (profissionalInicial) select.value = String(profissionalInicial.id);
    document.getElementById('disp-data-consulta').value =
        document.getElementById('data-agenda').value || paraIsoDate(new Date());
    preencherFormEscala(profissionalInicial);
    trocarAbaDisponibilidade('vagas');
    modal.classList.add('active');
    renderizarDisponibilidade();
}

function trocarAbaDisponibilidade(aba) {
    const mostrarVagas = aba === 'vagas';
    document.getElementById('aba-ver-vagas').hidden = !mostrarVagas;
    document.getElementById('form-escala-profissional').hidden = mostrarVagas;
    document.getElementById('tab-btn-ver-vagas').classList.toggle('active', mostrarVagas);
    document.getElementById('tab-btn-ver-vagas').setAttribute('aria-selected', String(mostrarVagas));
    document.getElementById('tab-btn-config-escala').classList.toggle('active', !mostrarVagas);
    document.getElementById('tab-btn-config-escala').setAttribute('aria-selected', String(!mostrarVagas));
}

export function initAgenda() {
    const modalAgenda = document.getElementById('modal-agendamento');
    const inputDataAgenda = document.getElementById('data-agenda');
    const filtroProfissional = document.getElementById('filtro-profissional');
    
    inputDataAgenda.value = new Date().toISOString().split('T')[0];
    
    document.getElementById('btn-novo-agendamento').addEventListener('click', () => abrirModalAgendamento());
    document.getElementById('btn-close-agendamento').addEventListener('click', () => modalAgenda.classList.remove('active'));
    
    inputDataAgenda.addEventListener('change', atualizarAgenda);
    filtroProfissional.addEventListener('change', atualizarAgenda);

    document.getElementById('agenda-data').addEventListener('change', () => atualizarHorariosDoAgendamento());
    document.getElementById('agenda-profissional').addEventListener('change', () => atualizarHorariosDoAgendamento());
    document.getElementById('agenda-hora').addEventListener('change', atualizarDisponibilidadeSalas);

    const tipoAtendimento = document.getElementById('agenda-tipo');
    const selectProcedimento = document.getElementById('agenda-procedimento');
    const selectProfissional = document.getElementById('agenda-profissional');

    if (tipoAtendimento) {
        tipoAtendimento.addEventListener('change', () => {
            popularSelectProcedimentos();
            atualizarVisualizacaoProcedimento();
        });
    }
    if (selectProcedimento) selectProcedimento.addEventListener('change', atualizarVisualizacaoProcedimento);
    if (selectProfissional) {
        selectProfissional.addEventListener('change', () => {
            popularSelectProcedimentos();
            atualizarVisualizacaoProcedimento();
        });
    }

    document.getElementById('btn-add-procedimento-agenda')?.addEventListener('click', adicionarItemProcedimentoAtual);

    document.getElementById('agenda-itens-selecionados')?.addEventListener('click', (e) => {
        const btnRem = e.target.closest('.btn-remover-item-agenda');
        if (!btnRem) return;
        const idx = parseInt(btnRem.getAttribute('data-idx'), 10);
        if (!Number.isNaN(idx)) {
            itensProcedimentoAgenda.splice(idx, 1);
            renderizarItensProcedimentoAgenda();
        }
    });

    const modalBloqueio = document.getElementById('modal-bloqueio');
    const selectTipoBloqueio = document.getElementById('bloqueio-tipo');
    const grupoHorarioEspecifico = document.getElementById('bloqueio-horario-especifico-group');

    const modalDisponibilidade = document.getElementById('modal-disponibilidade');
    document.getElementById('btn-checar-disponibilidade').addEventListener('click', abrirModalDisponibilidade);
    document.getElementById('btn-close-disponibilidade').addEventListener('click', () => modalDisponibilidade.classList.remove('active'));
    document.getElementById('disp-profissional').addEventListener('change', () => {
        const profissional = clinicaState.profissionais.find(p => String(p.id) === document.getElementById('disp-profissional').value);
        preencherFormEscala(profissional);
        renderizarDisponibilidade();
    });
    document.getElementById('disp-data-consulta').addEventListener('change', renderizarDisponibilidade);
    document.getElementById('tab-btn-ver-vagas').addEventListener('click', () => trocarAbaDisponibilidade('vagas'));
    document.getElementById('tab-btn-config-escala').addEventListener('click', () => trocarAbaDisponibilidade('escala'));
    document.getElementById('escala-tipo-frequencia').addEventListener('change', atualizarTipoFrequenciaEscala);
    document.getElementById('btn-add-data-escala').addEventListener('click', () => {
        const input = document.getElementById('escala-nova-data-input');
        if (!input.value) {
            showToast('Selecione uma data para incluir na escala.', 'error');
            return;
        }
        if (datasEscalaPendentes.includes(input.value)) {
            showToast('Esta data já foi incluída.', 'error');
            return;
        }
        datasEscalaPendentes = [...datasEscalaPendentes, input.value].sort();
        input.value = '';
        renderizarChipsDatasEscala();
    });
    document.getElementById('escala-datas-chips').addEventListener('click', (event) => {
        const button = event.target.closest('.btn-remover-data-escala');
        if (!button) return;
        datasEscalaPendentes = datasEscalaPendentes.filter(data => data !== button.dataset.data);
        renderizarChipsDatasEscala();
    });
    document.getElementById('form-escala-profissional').addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!['admin', 'recepcao'].includes(clinicaState.sessao.perfil)) {
            showToast('Somente administração ou recepção pode configurar a escala.', 'error');
            return;
        }

        const profissionalId = document.getElementById('disp-profissional').value;
        const profissional = clinicaState.profissionais.find(p => String(p.id) === String(profissionalId));
        if (!profissional) {
            showToast('Selecione um profissional válido.', 'error');
            return;
        }

        const frequencia = document.getElementById('escala-tipo-frequencia').value;
        const intervalo = Number(document.getElementById('escala-intervalo').value);
        const diasSemana = Array.from(document.querySelectorAll('input[name="escala-dia-sem"]:checked'))
            .map(checkbox => Number(checkbox.value));
        const config = {
            frequencia,
            intervalo,
            diasSemana,
            datas: [...datasEscalaPendentes],
            manhaInicio: document.getElementById('escala-manha-inicio').value,
            manhaFim: document.getElementById('escala-manha-fim').value,
            tardeInicio: document.getElementById('escala-tarde-inicio').value,
            tardeFim: document.getElementById('escala-tarde-fim').value
        };
        const turnos = obterTurnosEscala(config);
        const horarioManhaFim = minutosDoHorario(config.manhaFim);
        const horarioTardeInicio = minutosDoHorario(config.tardeInicio);

        if (!['semanal', 'mensal'].includes(frequencia)) {
            showToast('Selecione uma frequência de atendimento válida.', 'error');
            return;
        }
        if (!Number.isInteger(intervalo) || ![20, 30, 40, 45, 50, 60].includes(intervalo)) {
            showToast('Selecione um intervalo válido entre pacientes.', 'error');
            return;
        }
        if ((config.manhaInicio && !config.manhaFim) || (!config.manhaInicio && config.manhaFim)
            || (config.tardeInicio && !config.tardeFim) || (!config.tardeInicio && config.tardeFim)
            || turnos.some(turno =>
                minutosDoHorario(turno.inicio) === null
                || minutosDoHorario(turno.fim) === null
                || minutosDoHorario(turno.inicio) >= minutosDoHorario(turno.fim)
            )
            || (config.manhaFim && config.tardeInicio && horarioTardeInicio < horarioManhaFim)) {
            showToast('Confira os horários: cada turno precisa de início e fim válidos, sem sobreposição.', 'error');
            return;
        }
        if (turnos.length === 0 || turnos.some(turno =>
            minutosDoHorario(turno.fim) - minutosDoHorario(turno.inicio) < intervalo
        )) {
            showToast('Informe ao menos um turno com duração suficiente para um atendimento.', 'error');
            return;
        }
        if (frequencia === 'semanal' && diasSemana.length === 0) {
            showToast('Selecione ao menos um dia da semana.', 'error');
            return;
        }
        if (frequencia === 'mensal' && config.datas.length === 0) {
            showToast('Inclua ao menos uma data específica para esta escala.', 'error');
            return;
        }

        const btnSalvar = event.currentTarget.querySelector('button[type="submit"]');
        await comEstadoDeCarregamento(btnSalvar, 'Salvando...', async () => {
            try {
                await updateDoc(doc(db, 'profissionais', profissionalId), { agendaConfig: config });
                profissional.agendaConfig = config;
                renderizarDisponibilidade();
                trocarAbaDisponibilidade('vagas');
                showToast('Escala do profissional salva com sucesso.', 'success');
                await registrarAuditoria({
                    acao: 'Edição',
                    modulo: 'Agenda',
                    descricao: `Escala de ${profissional.nome} atualizada (${frequencia})`
                });
            } catch (error) {
                console.error('Erro ao salvar escala do profissional:', error);
                showToast('Falha ao salvar a escala. Verifique sua conexão e permissão de acesso.', 'error');
            }
        });
    });

    document.getElementById('btn-novo-bloqueio').addEventListener('click', () => abrirModalBloqueio());
    document.getElementById('btn-close-bloqueio').addEventListener('click', () => modalBloqueio.classList.remove('active'));

    selectTipoBloqueio.addEventListener('change', (e) => {
        grupoHorarioEspecifico.style.display = e.target.value === 'horario' ? 'grid' : 'none';
    });

    document.getElementById('form-bloqueio').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btnSalvar = e.target.querySelector('button[type="submit"]');

        await comEstadoDeCarregamento(btnSalvar, 'Bloqueando...', async () => {
            const profId = document.getElementById('bloqueio-profissional').value;
            const data = document.getElementById('bloqueio-data').value;
            const tipo = selectTipoBloqueio.value;
            const horaInicio = tipo === 'horario' ? document.getElementById('bloqueio-hora-inicio').value : null;
            const horaFim = tipo === 'horario' ? document.getElementById('bloqueio-hora-fim').value : null;

            if (tipo === 'horario' && horaInicio > horaFim) {
                showToast('O horário de início não pode ser depois do horário de fim.', 'error');
                return;
            }

            const conflito = clinicaState.agenda.agendamentos.some(a => {
                if (a.profId !== String(profId) || a.data !== data || a.status === 'cancelado') return false;
                if (tipo === 'dia_inteiro') return true;
                return a.hora >= horaInicio && a.hora <= horaFim;
            });

            if (conflito) {
                showToast('Já existe consulta marcada nesse período. Cancele a consulta antes de bloquear o horário.', 'error');
                return;
            }

            try {
                const profissional = clinicaState.profissionais.find(p => String(p.id) === String(profId));
                const motivo = document.getElementById('bloqueio-motivo').value;

                await addDoc(collection(db, "bloqueios_agenda"), {
                    profId: String(profId),
                    data,
                    tipo,
                    horaInicio,
                    horaFim,
                    motivo,
                    bloqueadoPor: clinicaState.sessao.nome,
                    clinicaId: clinicaState.sessao.clinicaId
                });

                modalBloqueio.classList.remove('active');
                e.target.reset();
                grupoHorarioEspecifico.style.display = 'none';
                showToast('Horário bloqueado com sucesso.', 'success');

                await registrarAuditoria({
                    acao: 'Criação',
                    modulo: 'Agenda',
                    descricao: `Horário bloqueado para ${profissional ? profissional.nome : profId} em ${data}`
                });

                await carregarBloqueios();
            } catch (error) {
                console.error("Erro ao bloquear horário: ", error);
                showToast('Falha de conexão ao bloquear horário.', 'error');
            }
        });
    });

    document.getElementById('form-agendamento').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btnSalvar = e.target.querySelector('button[type="submit"]');

        await comEstadoDeCarregamento(btnSalvar, 'Agendando...', async () => {
            const pacId = document.getElementById('agenda-paciente').value;
            const profId = document.getElementById('agenda-profissional').value;
            const sala = document.getElementById('agenda-sala').value;
            const dataAgendamento = document.getElementById('agenda-data').value;
            const horaAgendamento = document.getElementById('agenda-hora').value;
            const tipoAtendimento = document.getElementById('agenda-tipo').value;
            const selectProcedimento = document.getElementById('agenda-procedimento');
            const isPacote = tipoAtendimento === 'pacote';
            const isRevisao = tipoAtendimento === 'revisao';

            let itensFinais = [...itensProcedimentoAgenda];
            let procedimentoId = null;
            let procedimentoNome = 'Revisão (sem custo)';
            let valorAtendimento = 0;

            if (!isRevisao) {
                if (itensFinais.length === 0) {
                    const itemSelecionadoId = selectProcedimento ? selectProcedimento.value : '';
                    const itemObj = isPacote
                        ? clinicaState.pacotes.find(p => String(p.id) === String(itemSelecionadoId))
                        : clinicaState.procedimentos.find(p => String(p.id) === String(itemSelecionadoId));

                    if (!itemSelecionadoId || !itemObj) {
                        showToast(isPacote ? 'Selecione um pacote válido.' : 'Selecione um procedimento válido.', 'error');
                        return;
                    }
                    itensFinais.push({
                        id: String(itemObj.id),
                        nome: itemObj.nome,
                        valor: obterValorProcedimentoSelecionado()
                    });
                }

                procedimentoId = itensFinais[0].id;
                procedimentoNome = itensFinais.map(i => i.nome).join(' + ');
                valorAtendimento = itensFinais.reduce((soma, i) => soma + Number(i.valor || 0), 0);
            }
            const paciente = clinicaState.pacientes.find(p => String(p.id) === String(pacId));

            if (tipoAtendimento === 'procedimento_avulso' && !procedimentoId) {
                showToast('Selecione um procedimento válido para o atendimento avulso.', 'error');
                return;
            }

            if (!sala) {
                showToast('Selecione a sala onde a consulta vai acontecer.', 'error');
                return;
            }

            // A escala do profissional manda: não agenda fora dos dias/horários dele(a)
            const profissionalEscolhido = clinicaState.profissionais.find(p => String(p.id) === String(profId));
            const horariosDaEscala = obterHorariosDaEscala(profissionalEscolhido, dataAgendamento);
            if (horariosDaEscala !== null && !horariosDaEscala.includes(horaAgendamento)) {
                showToast(`${profissionalEscolhido.nome} não atende em ${dataBR(dataAgendamento)} às ${horaAgendamento || '--:--'}. Escolha um dia e horário da escala dele(a).`, 'error');
                return;
            }

            const pacienteOcupado = clinicaState.agenda.agendamentos.find(a => 
                String(a.pacId) === String(pacId) && 
                a.data === dataAgendamento && 
                a.hora === horaAgendamento &&
                a.status !== 'cancelado'
            );

            if (pacienteOcupado) {
                showToast(`O paciente ${paciente ? paciente.nome : ''} já possui uma consulta neste mesmo horário (Sala ${pacienteOcupado.sala}).`, 'error');
                return;
            }

            const ehAdmin = clinicaState.sessao.perfil === 'admin';

            const horarioOcupado = clinicaState.agenda.agendamentos.find(a => 
                a.profId === String(profId) && 
                a.data === dataAgendamento && 
                a.hora === horaAgendamento &&
                a.status !== 'cancelado'
            );

            if (horarioOcupado) {
                if (ehAdmin) {
                    const forcar = await confirmarAcao(
                        'Este profissional já tem um paciente agendado neste horário. Deseja agendar mesmo assim?',
                        { titulo: 'Horário já ocupado', textoConfirmar: 'Agendar mesmo assim', perigoso: true }
                    );
                    if (!forcar) return;
                } else {
                    showToast('Atenção: Este profissional já possui um paciente agendado neste horário!', 'error');
                    return; 
                }
            }

            const salaOcupada = clinicaState.agenda.agendamentos.find(a =>
                String(a.sala) === String(sala) &&
                a.data === dataAgendamento &&
                a.hora === horaAgendamento &&
                a.status !== 'cancelado'
            );

            if (salaOcupada) {
                if (ehAdmin) {
                    const forcar = await confirmarAcao(
                        `A Sala ${sala} já está ocupada nesse horário. Deseja forçar esse agendamento?`,
                        { titulo: 'Sala já ocupada', textoConfirmar: 'Agendar mesmo assim', perigoso: true }
                    );
                    if (!forcar) return;
                } else {
                    showToast(`A Sala ${sala} já está ocupada por outro profissional nesse horário.`, 'error');
                    return;
                }
            }

            const bloqueio = obterBloqueio(profId, dataAgendamento, horaAgendamento);
            if (bloqueio) {
                if (ehAdmin) {
                    const forcar = await confirmarAcao(
                        'Este horário está bloqueado para este profissional. Deseja agendar mesmo assim?',
                        { titulo: 'Horário bloqueado', textoConfirmar: 'Agendar mesmo assim', perigoso: true }
                    );
                    if (!forcar) return;
                } else {
                    showToast('Este horário está bloqueado para este profissional.', 'error');
                    return;
                }
            }

            try {
                await addDoc(collection(db, "agendamentos"), {
                    pacId: String(pacId),
                    pacNome: paciente ? paciente.nome : 'Paciente',
                    profId: String(profId),
                    sala: String(sala),
                    data: dataAgendamento,
                    hora: horaAgendamento,
                    tipo: isRevisao ? 'Revisão (sem custo)' : (tipoAtendimento === 'procedimento_avulso' ? 'Procedimento avulso' : 'Sessão de Pacote'),
                    procedimentoId: procedimentoId,
                    procedimentoNome: procedimentoNome,
                    itens: itensFinais,
                    valorAtendimento: valorAtendimento,
                    statusPagamento: valorAtendimento > 0 ? 'pendente' : 'nao_aplica',
                    status: 'agendado', 
                    clinicaId: clinicaState.sessao.clinicaId
                });
                
                modalAgenda.classList.remove('active');
                e.target.reset();
                showToast('Consulta agendada com sucesso!', 'success');

                const pendenciasResolvidasAoAgendar = clinicaState.notificacoes.filter(n =>
                    n.status === 'pendente' &&
                    String(n.pacienteId) === String(pacId) &&
                    (n.tipo === 'retorno_pendente' || n.tipo === 'encaminhamento')
                );
                for (const pend of pendenciasResolvidasAoAgendar) {
                    try {
                        await updateDoc(doc(db, "notificacoes", pend.id), {
                            status: 'concluida',
                            resolvidoPor: clinicaState.sessao.nome,
                            resolvidoEm: new Date().toISOString(),
                            resolvidoAutomaticamente: true
                        });
                    } catch (err) {
                        console.error("Erro ao auto-resolver notificação vinculada: ", err);
                    }
                }
                
                await carregarAgendamentos(); 
            } catch (error) {
                console.error("Erro ao agendar: ", error);
                showToast('Falha de conexão ao agendar.', 'error');
            }
        });
    });

    const modalConfirmarAgendamento = document.getElementById('modal-confirmar-agendamento');
    const modalCancelarAgendamento = document.getElementById('modal-cancelar-agendamento');

    function fecharModaisDeStatus() {
        modalConfirmarAgendamento.classList.remove('active');
        modalCancelarAgendamento.classList.remove('active');
        agendamentoIdParaAtualizar = null;
        notificacaoIdEmResolucao = null;
        pagamentoAdicionalConfirmado = false;
        atualizarAgenda();
    }

    document.getElementById('btn-close-confirmar-agendamento').addEventListener('click', fecharModaisDeStatus);
    document.getElementById('btn-close-cancelar-agendamento').addEventListener('click', fecharModaisDeStatus);

    const checkVerificacaoPagamento = document.getElementById('pagamento-verificacao-confirmada');
    if (checkVerificacaoPagamento) {
        checkVerificacaoPagamento.addEventListener('change', (e) => {
            const btnSubmit = document.getElementById('btn-confirmar-pagamento-submit');
            if (btnSubmit) btnSubmit.disabled = !e.target.checked;
        });
    }

    // Atualiza o valor entre Espécie e Cartão/Pix ao trocar a forma de pagamento.
    const selectFormaPagamento = document.getElementById('pagamento-forma');
    if (selectFormaPagamento) {
        selectFormaPagamento.addEventListener('change', () => {
            if (!agendamentoIdParaAtualizar) return;
            const ag = clinicaState.agenda.agendamentos.find(a => String(a.id) === String(agendamentoIdParaAtualizar));
            if (!ag) return;

            let novoValor = 0;
            if (Array.isArray(ag.itens) && ag.itens.length > 0) {
                novoValor = ag.itens.reduce((soma, it) => {
                    const v = valorDoProcedimentoParaProfissional(it.id, ag.profId, selectFormaPagamento.value);
                    return soma + (v > 0 ? v : Number(it.valor || 0));
                }, 0);
            } else if (ag.procedimentoId) {
                novoValor = valorDoProcedimentoParaProfissional(ag.procedimentoId, ag.profId, selectFormaPagamento.value);
            }

            if (novoValor > 0) {
                const inputValor = document.getElementById('pagamento-valor');
                if (inputValor) {
                    inputValor.value = novoValor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                }
            }
        });
    }

    document.getElementById('form-confirmar-agendamento').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!agendamentoIdParaAtualizar) return;

        const btnSalvar = e.target.querySelector('button[type="submit"]');
        const idAgendamento = agendamentoIdParaAtualizar;
        const agendamento = clinicaState.agenda.agendamentos.find(a => String(a.id) === String(idAgendamento));

        if (!agendamento) {
            showToast('Agendamento não localizado.', 'error');
            return;
        }

        const valorTexto = document.getElementById('pagamento-valor').value.replace(/\./g, '').replace(',', '.');
        const valorPago = parseFloat(valorTexto);
        const formaPagamento = document.getElementById('pagamento-forma').value;

        if (!formaPagamento || !valorPago || valorPago <= 0) {
            showToast('Informe a forma de pagamento e um valor válido.', 'error');
            return;
        }

        const checkVerificacao = document.getElementById('pagamento-verificacao-confirmada');
        if (checkVerificacao && !checkVerificacao.checked) {
            showToast('Confirme que conferiu o valor e a forma de pagamento antes de salvar.', 'error');
            return;
        }

        if (agendamento.statusPagamento === 'pago' && !pagamentoAdicionalConfirmado) {
            showToast('Esta consulta já foi paga.', 'error');
            return;
        }

        await comEstadoDeCarregamento(btnSalvar, 'Confirmando...', async () => {
            try {
                const chegouMarcado = document.getElementById('confirmacao-chegou')?.checked;
                let statusFinal = agendamento.status || 'agendado';
                if (statusFinal === 'agendado') statusFinal = 'confirmado';
                if (chegouMarcado && statusFinal !== 'concluido') statusFinal = 'aguardando_atendimento';

                const updateData = {
                    status: statusFinal,
                    statusPagamento: 'pago',
                    valorAtendimento: valorPago,
                    pagoEm: new Date().toISOString(),
                    pagoPor: clinicaState.sessao.nome,
                    observacaoConfirmacao: {
                        whatsapp: document.getElementById('confirmacao-whatsapp').checked,
                        pagamento: true,
                        chegou: chegouMarcado,
                        observacoes: document.getElementById('confirmacao-observacoes').value,
                        formaPagamento,
                        valorPago
                    }
                };

                const dadosFinanceiro = montarDadosFinanceiroDoAgendamento({
                    ...agendamento,
                    valorAtendimento: valorPago,
                    status: statusFinal
                }, formaPagamento, valorPago);

                await confirmarPagamentoTransacional(idAgendamento, updateData, dadosFinanceiro, pagamentoAdicionalConfirmado);

                await registrarAuditoria({
                    acao: 'Criação',
                    modulo: 'Financeiro',
                    descricao: `Pagamento confirmado: ${agendamento.pacNome} - ${agendamento.procedimentoNome || agendamento.tipo || 'Consulta'} (${formatCurrency(dadosFinanceiro.valor)})`
                });

                const idxAgendamento = clinicaState.agenda.agendamentos.findIndex(a => String(a.id) === String(idAgendamento));
                if (idxAgendamento >= 0) {
                    clinicaState.agenda.agendamentos[idxAgendamento] = {
                        ...clinicaState.agenda.agendamentos[idxAgendamento],
                        ...updateData
                    };
                }

                showToast('Pagamento confirmado e lançado no caixa!', 'success');

                if (notificacaoIdEmResolucao) {
                    try {
                        await updateDoc(doc(db, "notificacoes", notificacaoIdEmResolucao), {
                            status: 'concluida',
                            resolvidoPor: clinicaState.sessao.nome,
                            resolvidoEm: new Date().toISOString()
                        });
                    } catch (error) {
                        console.error("Erro ao encerrar notificação de pagamento: ", error);
                    }
                    notificacaoIdEmResolucao = null;
                }

                modalConfirmarAgendamento.classList.remove('active');
                e.target.reset();
                agendamentoIdParaAtualizar = null;
                pagamentoAdicionalConfirmado = false;
                atualizarAgenda(); 
            } catch (error) {
                if (error.message === 'JA_PAGO_NO_BANCO') {
                    showToast('Esta consulta já foi paga em outra sessão.', 'error');
                    modalConfirmarAgendamento.classList.remove('active');
                    await carregarAgendamentos();
                    return;
                }
                console.error("Erro ao confirmar pagamento: ", error);
                showToast('Erro ao confirmar pagamento.', 'error');
            }
        });
    });

    document.getElementById('form-cancelar-agendamento').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!agendamentoIdParaAtualizar) return;

        const btnSalvar = e.target.querySelector('button[type="submit"]');
        const idAgendamento = agendamentoIdParaAtualizar;

        await comEstadoDeCarregamento(btnSalvar, 'Cancelando...', async () => {
            try {
                await updateDoc(doc(db, "agendamentos", idAgendamento), {
                    status: 'cancelado',
                    motivoCancelamento: document.getElementById('cancelamento-motivo').value,
                    canceladoPor: clinicaState.sessao.nome,
                    canceladoEm: new Date().toISOString()
                });
                showToast('Consulta cancelada.', 'success');
                modalCancelarAgendamento.classList.remove('active');
                e.target.reset();
                agendamentoIdParaAtualizar = null;
                await carregarAgendamentos();
            } catch (error) {
                console.error("Erro ao cancelar consulta: ", error);
                showToast('Erro ao cancelar consulta.', 'error');
            }
        });
    });

    const agendaContainer = document.getElementById('agenda-professionals');
    if (agendaContainer) {
        agendaContainer.addEventListener('click', async (e) => {
            const btnRemoverBloqueio = e.target.closest('.btn-remover-bloqueio');
            if (btnRemoverBloqueio) {
                e.stopPropagation();
                if (await confirmarAcao('Deseja remover este bloqueio e liberar o horário?', { titulo: 'Remover bloqueio', textoConfirmar: 'Remover', perigoso: false })) {
                    const idBloqueio = btnRemoverBloqueio.getAttribute('data-id');
                    try {
                        await deleteDoc(doc(db, "bloqueios_agenda", idBloqueio));
                        showToast('Bloqueio removido.', 'success');
                        await carregarBloqueios();
                    } catch (error) {
                        showToast('Erro ao remover bloqueio.', 'error');
                    }
                }
            }
        });
    }

    const modalDetalhe = document.getElementById('modal-detalhe-agendamento');
    const selectStatusDetalhe = document.getElementById('detalhe-agendamento-status');
    const btnPagarDetalhe = document.getElementById('btn-confirmar-pagamento-detalhe');
    const btnCancelarDetalhe = document.getElementById('btn-cancelar-consulta-detalhe');
    const btnCloseDetalhe = document.getElementById('btn-close-detalhe-agendamento');

    if (btnCloseDetalhe) {
        btnCloseDetalhe.addEventListener('click', () => {
            modalDetalhe.classList.remove('active');
            agendamentoIdParaAtualizar = null;
        });
    }

    if (btnPagarDetalhe) {
        btnPagarDetalhe.addEventListener('click', () => {
            if (!agendamentoIdParaAtualizar) return;
            modalDetalhe.classList.remove('active');
            const notifExistente = clinicaState.notificacoes.find(n =>
                n.tipo === 'pagamento_pendente' && n.status === 'pendente' && String(n.agendamentoId) === String(agendamentoIdParaAtualizar)
            );
            abrirModalPagamento(agendamentoIdParaAtualizar, notifExistente?.id || null);
        });
    }

    if (btnCancelarDetalhe) {
        btnCancelarDetalhe.addEventListener('click', () => {
            if (!agendamentoIdParaAtualizar) return;
            modalDetalhe.classList.remove('active');
            document.getElementById('form-cancelar-agendamento').reset();
            modalCancelarAgendamento.classList.add('active');
        });
    }

    // Troca de status dentro do modal de detalhe: agora muda a etapa de presença sem forçar o modal de pagamento
    if (selectStatusDetalhe) {
        selectStatusDetalhe.addEventListener('change', async (e) => {
            if (!agendamentoIdParaAtualizar) return;
            const idAgendamento = agendamentoIdParaAtualizar;
            const novoStatus = e.target.value;

            if (novoStatus === 'cancelado') {
                document.getElementById('form-cancelar-agendamento').reset();
                modalDetalhe.classList.remove('active');
                modalCancelarAgendamento.classList.add('active');
                return;
            }

            modalDetalhe.classList.remove('active');
            await alterarStatusConsultaRapido(idAgendamento, novoStatus);
        });
    }

    const selectVisao = document.getElementById('agenda-visao');
    if (selectVisao) selectVisao.addEventListener('change', atualizarAgenda);

    const toggle = document.getElementById('agenda-periodo-toggle');
    if (toggle) {
        toggle.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-periodo]');
            if (!btn) return;
            periodoAtual = btn.getAttribute('data-periodo');
            toggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
            const selVisao = document.getElementById('agenda-visao');
            if (selVisao) selVisao.style.display = periodoAtual === 'dia' ? '' : 'none';
            atualizarAgenda();
        });
    }

    document.getElementById('btn-agenda-hoje')?.addEventListener('click', () => {
        inputDataAgenda.value = new Date().toISOString().split('T')[0];
        atualizarAgenda();
    });

    document.getElementById('btn-agenda-anterior')?.addEventListener('click', () => navegarData(-1));
    document.getElementById('btn-agenda-proximo')?.addEventListener('click', () => navegarData(1));
}

function navegarData(direcao) {
    const inputDataAgenda = document.getElementById('data-agenda');
    const dataAtual = parseDataLocal(inputDataAgenda.value || new Date().toISOString().split('T')[0]);

    if (periodoAtual === 'dia') dataAtual.setDate(dataAtual.getDate() + direcao);
    else if (periodoAtual === 'semana') dataAtual.setDate(dataAtual.getDate() + (direcao * 7));
    else dataAtual.setMonth(dataAtual.getMonth() + direcao);

    inputDataAgenda.value = paraIsoDate(dataAtual);
    atualizarAgenda();
}

export function abrirModalAgendamento(hora = '', profId = '', data = '') {
    const modalAgenda = document.getElementById('modal-agendamento');
    const selPac = document.getElementById('agenda-paciente');
    const selProf = document.getElementById('agenda-profissional');
    const inputDataAgenda = document.getElementById('data-agenda');

    itensProcedimentoAgenda = [];
    renderizarItensProcedimentoAgenda();
    
    let profsPermitidos = clinicaState.profissionais;
    if (clinicaState.sessao.perfil === 'Doutor(a)') {
        profsPermitidos = profissionaisDoUsuario();
    }

    selPac.innerHTML = clinicaState.pacientes.map(p => `<option value="${p.id}">${escapeHTML(p.nome)}</option>`).join('');
    selProf.innerHTML = profsPermitidos.map(p => `<option value="${p.id}">${escapeHTML(p.nome)} (${escapeHTML(p.especialidade)})</option>`).join('');
    
    selProf.disabled = clinicaState.sessao.perfil === 'Doutor(a)';
    
    document.getElementById('agenda-data').value = data || inputDataAgenda.value;
    if (profId) selProf.value = profId;

    adicionarBuscaAoSelect(selPac, 'paciente');
    adicionarBuscaAoSelect(selProf, 'profissional');

    const tipoAtendimento = document.getElementById('agenda-tipo');
    if (tipoAtendimento) tipoAtendimento.value = 'procedimento_avulso';

    popularSelectProcedimentos();
    document.getElementById('agenda-sala').value = '';
    atualizarHorariosDoAgendamento(hora);
    atualizarVisualizacaoProcedimento();
    
    modalAgenda.classList.add('active');
}

function atualizarDisponibilidadeSalas() {
    const selectSala = document.getElementById('agenda-sala');
    if (!selectSala) return;

    const data = document.getElementById('agenda-data').value;
    const hora = document.getElementById('agenda-hora').value;

    const ocupadas = new Set(
        clinicaState.agenda.agendamentos
            .filter(a => a.data === data && a.hora === hora && a.status !== 'cancelado')
            .map(a => String(a.sala))
    );

    const valorAtual = selectSala.value;
    Array.from(selectSala.options).forEach(opt => {
        if (!opt.value) return; 
        const ocupada = ocupadas.has(opt.value);
        opt.disabled = ocupada;
        opt.textContent = ocupada ? `Sala ${opt.value} (ocupada)` : `Sala ${opt.value}`;
    });

    if (valorAtual && ocupadas.has(valorAtual)) selectSala.value = '';
}

export function abrirModalBloqueio() {
    const modalBloqueio = document.getElementById('modal-bloqueio');
    const selProf = document.getElementById('bloqueio-profissional');
    const inputDataAgenda = document.getElementById('data-agenda');

    let profsPermitidos = clinicaState.profissionais;
    if (clinicaState.sessao.perfil === 'Doutor(a)') {
        profsPermitidos = profissionaisDoUsuario();
    }

    selProf.innerHTML = profsPermitidos.map(p => `<option value="${p.id}">${escapeHTML(p.nome)} (${escapeHTML(p.especialidade)})</option>`).join('');
    adicionarBuscaAoSelect(selProf, 'profissional'); // <-- ADICIONE ESTA LINHA

    document.getElementById('bloqueio-data').value = inputDataAgenda.value;
    document.getElementById('bloqueio-tipo').value = 'dia_inteiro';
    document.getElementById('bloqueio-horario-especifico-group').style.display = 'none';

    modalBloqueio.classList.add('active');
}

export function atualizarAgenda() {
    const container = document.getElementById('agenda-professionals');
    const colHorarios = document.getElementById('time-column-slots');
    if (!container || !colHorarios) return;

    const inputDataAgenda = document.getElementById('data-agenda');
    const dataSelecionada = inputDataAgenda.value;
    const filtroProfissional = document.getElementById('filtro-profissional');
    const selectVisao = document.getElementById('agenda-visao');

    let profsPermitidos = clinicaState.profissionais;
    let mostrarTodos = true;

    if (clinicaState.sessao.perfil === 'Doutor(a)') {
        profsPermitidos = profissionaisDoUsuario();
        mostrarTodos = profsPermitidos.length > 1;
        if (selectVisao) selectVisao.style.display = 'none';
    }

    let opcoesFiltro = '';
    if (mostrarTodos) opcoesFiltro += `<option value="todos">Todos os Profissionais</option>`;
    opcoesFiltro += profsPermitidos.map(p => `<option value="${p.id}">${escapeHTML(p.nome)}</option>`).join('');

    const valorAnterior = filtroProfissional.value;
    filtroProfissional.innerHTML = opcoesFiltro;
    if (mostrarTodos && valorAnterior) filtroProfissional.value = valorAnterior;
    adicionarBuscaAoSelect(filtroProfissional, 'profissional na agenda');

    const viewDia = document.getElementById('agenda-view-dia');
    const viewSemana = document.getElementById('agenda-view-semana');
    const viewMes = document.getElementById('agenda-view-mes');

    if (viewDia) viewDia.style.display = periodoAtual === 'dia' ? '' : 'none';
    if (viewSemana) viewSemana.style.display = periodoAtual === 'semana' ? '' : 'none';
    if (viewMes) viewMes.style.display = periodoAtual === 'mes' ? '' : 'none';

    if (selectVisao && clinicaState.sessao.perfil !== 'Doutor(a)') {
        selectVisao.style.display = periodoAtual === 'dia' ? '' : 'none';
    }

    atualizarRotuloPeriodo(dataSelecionada);
    renderizarBarraResumoRecepcao(dataSelecionada);

    if (periodoAtual === 'semana' || periodoAtual === 'mes') {
        filtroProfissional.style.display = '';
        if (periodoAtual === 'semana') renderizarVisaoSemana(dataSelecionada, filtroProfissional.value);
        else renderizarVisaoMes(dataSelecionada, filtroProfissional.value);
        return;
    }

    const visaoAtual = selectVisao ? selectVisao.value : 'profissionais';

    // Quais profissionais aparecem na grade (e portanto quais horários valem)
    const filtroPrevio = filtroProfissional.value;
    const profsDaGrade = visaoAtual === 'salas'
        ? []
        : (filtroPrevio === 'todos' ? profsPermitidos : profsPermitidos.filter(p => p.id == filtroPrevio));

    const timesNoDia = new Set();
    if (visaoAtual === 'salas' || profsDaGrade.length === 0) HORARIOS_PADRAO.forEach(h => timesNoDia.add(h));
    profsDaGrade.forEach(p => {
        const horariosEscala = obterHorariosDaEscala(p, dataSelecionada);
        (horariosEscala === null ? HORARIOS_PADRAO : horariosEscala).forEach(h => timesNoDia.add(h));
    });

    const idsNaGrade = new Set(profsDaGrade.map(p => String(p.id)));
    const aparece = (profId) => visaoAtual === 'salas' || idsNaGrade.size === 0 || idsNaGrade.has(String(profId));
    clinicaState.agenda.agendamentos.forEach(a => {
        if (a.data === dataSelecionada && a.status !== 'cancelado' && aparece(a.profId)) timesNoDia.add(a.hora);
    });
    clinicaState.agenda.bloqueios.forEach(b => {
        if (b.data === dataSelecionada && b.tipo === 'horario' && aparece(b.profId)) timesNoDia.add(b.horaInicio);
    });

    const appointmentTimes = Array.from(timesNoDia).sort();

    colHorarios.innerHTML = `<div class="time-slot-header">Horário</div>` +
        appointmentTimes.map(h => `<div class="time-slot">${h}</div>`).join('');

    filtroProfissional.style.display = visaoAtual === 'salas' ? 'none' : '';
    container.innerHTML = '';

    const bateFiltroStatus = (ag) => filtroStatusAtual === 'todos' || (ag.status || 'agendado') === filtroStatusAtual;
    
    if (visaoAtual === 'salas' && clinicaState.sessao.perfil !== 'Doutor(a)') {
        const salasFisicas = ['1', '2', '3', '4', '5'];
        salasFisicas.forEach(sala => {
            const coluna = document.createElement('div');
            coluna.className = 'professional-column';
            coluna.innerHTML = `<div class="prof-header"><strong>Sala ${sala}</strong><small>Consultório</small></div>`;
            
            appointmentTimes.forEach(hora => {
                const agendamento = clinicaState.agenda.agendamentos.find(a => 
                    String(a.sala) === sala && a.data === dataSelecionada && a.hora === hora && a.status !== 'cancelado' && bateFiltroStatus(a)
                );
                
                const slot = document.createElement('div');
                if (agendamento) {
                    renderizarSlotOcupado(slot, agendamento);
                } else {
                    slot.className = 'appointment-slot empty';
                    slot.textContent = 'Sala Livre';
                    slot.addEventListener('click', () => {
                        abrirModalAgendamento(hora, '', dataSelecionada);
                        setTimeout(() => {
                            const selSala = document.getElementById('agenda-sala');
                            if (selSala) selSala.value = sala;
                        }, 50);
                    });
                }
                coluna.appendChild(slot);
            });
            container.appendChild(coluna);
        });
        return;
    }

    let filtroAtual = filtroProfissional.value;
    const profsParaExibir = filtroAtual === 'todos' 
        ? profsPermitidos 
        : profsPermitidos.filter(p => p.id == filtroAtual);
        
    if (profsParaExibir.length === 0) {
        container.innerHTML = `
            <div class="professional-column empty-column">
                <div class="prof-header">
                    <strong>Sem Profissionais</strong>
                    <small>Seu usuário não está vinculado à lista de profissionais.</small>
                </div>
            </div>`;
        return;
    }
    
    profsParaExibir.forEach(prof => {
        const horariosDaEscala = obterHorariosDaEscala(prof, dataSelecionada);
        console.info('[agenda] escala de', prof.nome, '->', prof.agendaConfig ? 'configurada' : 'SEM agendaConfig', horariosDaEscala);
        const naoAtendeHoje = horariosDaEscala !== null && horariosDaEscala.length === 0;
        let avisoEscala = '';
        if (naoAtendeHoje) {
            const proximas = proximasDatasDaEscala(prof, dataSelecionada);
            avisoEscala = `<small class="prof-fora-escala">Não atende nesta data${proximas.length ? ' · próximas: ' + proximas.map(dataBR).join(', ') : ''}</small>`;
        }

        const coluna = document.createElement('div');
        coluna.className = 'professional-column';
        coluna.innerHTML = `<div class="prof-header"><strong>${escapeHTML(prof.nome)}</strong><small>${escapeHTML(prof.especialidade)}</small>${avisoEscala}</div>`;
        
        appointmentTimes.forEach(hora => {
            const agendamento = clinicaState.agenda.agendamentos.find(a => 
                a.profId == prof.id && a.data === dataSelecionada && a.hora === hora && a.status !== 'cancelado' && bateFiltroStatus(a)
            );
            
            const slot = document.createElement('div');
            if (agendamento) {
                renderizarSlotOcupado(slot, agendamento);
            } else if (horariosDaEscala !== null && !horariosDaEscala.includes(hora)) {
                slot.className = 'appointment-slot unavailable';
                slot.title = 'Fora da escala deste profissional';
                slot.textContent = '—';
            } else {
                const bloqueio = obterBloqueio(prof.id, dataSelecionada, hora);
                if (bloqueio) {
                    slot.className = 'appointment-slot blocked';
                    slot.innerHTML = `
                        <div class="appt-slot-header">
                            <span class="blocked-label"><i class="fa-solid fa-lock"></i> ${bloqueio.tipo === 'dia_inteiro' ? 'Folga (Dia Inteiro)' : 'Bloqueado'}</span>
                            <button class="appt-cancel-btn btn-remover-bloqueio" data-id="${bloqueio.id}" title="Remover bloqueio"><i class="fa-solid fa-xmark"></i></button>
                        </div>
                        ${bloqueio.motivo ? `<span class="appointment-type">${escapeHTML(bloqueio.motivo)}</span>` : ''}
                    `;
                } else {
                    slot.className = 'appointment-slot empty';
                    slot.textContent = 'Horário Livre';
                    slot.addEventListener('click', () => abrirModalAgendamento(hora, prof.id, dataSelecionada));
                }
            }
            coluna.appendChild(slot);
        });
        container.appendChild(coluna);
    });
}

function atualizarRotuloPeriodo(dataSelecionadaIso) {
    const label = document.getElementById('agenda-periodo-label');
    if (!label || !dataSelecionadaIso) return;
    const data = parseDataLocal(dataSelecionadaIso);

    if (periodoAtual === 'dia') {
        label.textContent = data.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
    } else if (periodoAtual === 'semana') {
        const domingo = obterDomingoDaSemana(data);
        const sabado = new Date(domingo);
        sabado.setDate(sabado.getDate() + 6);
        const mesmoMes = domingo.getMonth() === sabado.getMonth();
        const inicio = domingo.toLocaleDateString('pt-BR', { day: '2-digit', month: mesmoMes ? undefined : 'short' });
        const fim = sabado.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
        label.textContent = `${inicio} - ${fim}`;
    } else {
        label.textContent = `${NOMES_MES[data.getMonth()]} de ${data.getFullYear()}`;
    }
}

function agendamentosPermitidos(filtroProfId) {
    let profsPermitidos = clinicaState.profissionais;
    if (clinicaState.sessao.perfil === 'Doutor(a)') {
        profsPermitidos = profissionaisDoUsuario();
    }
    const idsPermitidos = new Set(profsPermitidos.map(p => String(p.id)));

    return clinicaState.agenda.agendamentos.filter(a => {
        if (a.status === 'cancelado') return false;
        if (!idsPermitidos.has(String(a.profId))) return false;
        if (filtroProfId && filtroProfId !== 'todos' && String(a.profId) !== String(filtroProfId)) return false;
        return true;
    });
}

function renderizarVisaoSemana(dataSelecionadaIso, filtroProfId) {
    const container = document.getElementById('agenda-view-semana');
    if (!container) return;

    const dataRef = parseDataLocal(dataSelecionadaIso);
    const domingo = obterDomingoDaSemana(dataRef);
    const hojeIso = paraIsoDate(new Date());
    const agendamentosDaSemana = agendamentosPermitidos(filtroProfId);

    container.innerHTML = '';

    for (let i = 0; i < 7; i++) {
        const diaAtual = new Date(domingo);
        diaAtual.setDate(diaAtual.getDate() + i);
        const diaIso = paraIsoDate(diaAtual);

        const coluna = document.createElement('div');
        coluna.className = 'week-day-column' + (diaIso === hojeIso ? ' is-today' : '');

        const doDia = agendamentosDaSemana
            .filter(a => a.data === diaIso)
            .sort((a, b) => (a.hora || '').localeCompare(b.hora || ''));

        coluna.innerHTML = `
            <div class="week-day-header">
                <span class="dow">${NOMES_DIA_SEMANA[diaAtual.getDay()]}</span>
                <span class="dnum">${diaAtual.getDate()}</span>
            </div>
            <div class="week-day-body">
                ${doDia.length === 0
                    ? '<div class="week-day-empty">Sem consultas</div>'
                    : doDia.map(a => {
                        const prof = clinicaState.profissionais.find(p => String(p.id) === String(a.profId));
                        return `
                        <div class="week-appt-chip" data-status="${a.status || 'agendado'}" data-id="${a.id}" title="${escapeHTML(a.pacNome)}">
                            <span class="chip-hora">${escapeHTML(a.hora)}</span>
                            <span class="chip-nome">${escapeHTML(a.pacNome)}</span>
                            <span class="chip-prof">${escapeHTML(prof ? prof.nome : '')}</span>
                        </div>`;
                    }).join('')
                }
            </div>
        `;

        coluna.querySelectorAll('.week-appt-chip').forEach(chip => {
            chip.addEventListener('click', () => abrirDetalheRapido(chip.getAttribute('data-id'), diaIso));
        });

        container.appendChild(coluna);
    }
}

function renderizarVisaoMes(dataSelecionadaIso, filtroProfId) {
    const grid = document.getElementById('agenda-month-grid');
    if (!grid) return;

    const dataRef = parseDataLocal(dataSelecionadaIso);
    const ano = dataRef.getFullYear();
    const mes = dataRef.getMonth();
    const hojeIso = paraIsoDate(new Date());

    const primeiroDiaDoMes = new Date(ano, mes, 1);
    const inicioGrade = obterDomingoDaSemana(primeiroDiaDoMes);
    const agendamentosDoPeriodo = agendamentosPermitidos(filtroProfId);
    const MAX_VISIVEIS = 3;

    grid.innerHTML = '';

    for (let i = 0; i < 42; i++) {
        const diaAtual = new Date(inicioGrade);
        diaAtual.setDate(diaAtual.getDate() + i);
        const diaIso = paraIsoDate(diaAtual);
        const foraDoMes = diaAtual.getMonth() !== mes;

        const doDia = agendamentosDoPeriodo
            .filter(a => a.data === diaIso)
            .sort((a, b) => (a.hora || '').localeCompare(b.hora || ''));

        const celula = document.createElement('div');
        celula.className = 'month-day-cell' + (foraDoMes ? ' outro-mes' : '') + (diaIso === hojeIso ? ' is-today' : '');

        const visiveis = doDia.slice(0, MAX_VISIVEIS);
        const restantes = doDia.length - visiveis.length;

        celula.innerHTML = `
            <span class="month-day-num">${diaAtual.getDate()}</span>
            <div class="month-day-dots">
                ${visiveis.map(a => `<span class="month-appt-dot" data-status="${a.status || 'agendado'}">${escapeHTML(a.hora)} ${escapeHTML(a.pacNome)}</span>`).join('')}
                ${restantes > 0 ? `<span class="month-day-mais">+${restantes} mais</span>` : ''}
            </div>
        `;

        celula.addEventListener('click', () => {
            periodoAtual = 'dia';
            document.querySelectorAll('#agenda-periodo-toggle button').forEach(b => b.classList.toggle('active', b.getAttribute('data-periodo') === 'dia'));
            const selVisao = document.getElementById('agenda-visao');
            if (selVisao && clinicaState.sessao.perfil !== 'Doutor(a)') selVisao.style.display = '';
            document.getElementById('data-agenda').value = diaIso;
            atualizarAgenda();
        });

        grid.appendChild(celula);
    }
}

function abrirDetalheRapido(idAgendamento, diaIso) {
    periodoAtual = 'dia';
    document.querySelectorAll('#agenda-periodo-toggle button').forEach(b => b.classList.toggle('active', b.getAttribute('data-periodo') === 'dia'));
    const selVisao = document.getElementById('agenda-visao');
    if (selVisao && clinicaState.sessao.perfil !== 'Doutor(a)') selVisao.style.display = '';
    document.getElementById('data-agenda').value = diaIso;
    atualizarAgenda();
}

// ========================================================
// NOVO CARD DA GRADE: CLARO, ORGANIZADO E COM CHECK-IN EM 1 CLIQUE
// ========================================================
function renderizarSlotOcupado(slot, agendamento) {
    const statusAtual = agendamento.status || 'agendado';
    slot.className = 'appointment-slot occupied';
    slot.dataset.status = statusAtual;
    slot.dataset.id = agendamento.id;

    const nomeAtendimento = agendamento.procedimentoNome || agendamento.tipo || 'Consulta';
    const temCobranca = Number(agendamento.valorAtendimento || 0) > 0 && agendamento.statusPagamento !== 'nao_aplica';
    const jaPago = agendamento.statusPagamento === 'pago';

    const selectVisao = document.getElementById('agenda-visao');
    const mostrarProfissional = selectVisao && selectVisao.value === 'salas';
    const nomeProfissional = mostrarProfissional
        ? clinicaState.profissionais.find(p => String(p.id) === String(agendamento.profId))?.nome || 'Profissional'
        : '';

    const meta = META_STATUS[statusAtual] || META_STATUS.agendado;

    // Botão de avanço de etapa com 1 clique
    const ehTriagem = Boolean(clinicaState.sessao.ehTriagem);
    const triagemPronta = Boolean(agendamento.triagemPronta);
    let botaoProximaEtapa = '';
    if (ehTriagem) {
        if (statusAtual === 'concluido') {
            botaoProximaEtapa = `<span class="appt-paid-tag"><i class="fa-solid fa-circle-check"></i> Finalizado</span>`;
        } else if (triagemPronta) {
            botaoProximaEtapa = `<span class="badge-triagem-pronta"><i class="fa-solid fa-clipboard-check"></i> Enviado p/ Médico</span>`;
        } else {
            botaoProximaEtapa = `<button type="button" class="btn-quick-step step-chegou btn-enviar-triagem" title="Finalizar triagem e enviar para o médico"><i class="fa-solid fa-paper-plane"></i> Enviar p/ Médico</button>`;
        }
    } else if (statusAtual === 'agendado') {
        botaoProximaEtapa = `<button type="button" class="btn-quick-step step-confirmar" data-next="confirmado" title="Confirmar presença com 1 clique"><i class="fa-solid fa-check"></i> Confirmar</button>`;
    } else if (statusAtual === 'confirmado') {
        botaoProximaEtapa = `<button type="button" class="btn-quick-step step-chegou" data-next="aguardando_atendimento" title="Paciente chegou na recepção (enviar p/ fila do médico)"><i class="fa-solid fa-person-walking-arrow-right"></i> Chegou (Fila)</button>`;
    } else if (statusAtual === 'aguardando_atendimento') {
        botaoProximaEtapa = `<button type="button" class="btn-quick-step step-concluir" data-next="concluido" title="Finalizar atendimento"><i class="fa-solid fa-check-double"></i> Concluir</button>`;
    } else {
        botaoProximaEtapa = `<span class="appt-paid-tag"><i class="fa-solid fa-circle-check"></i> Finalizado</span>`;
    }

    // Indicador / Botão de Caixa separado da presença
    let blocoFinanceiro = '';
    if (temCobranca) {
        blocoFinanceiro = jaPago
            ? `<span class="appt-paid-tag" title="Pagamento já registrado"><i class="fa-solid fa-sack-dollar"></i> Pago</span>`
            : `<button type="button" class="btn-quick-pay" title="Receber pagamento no caixa"><i class="fa-solid fa-dollar-sign"></i> Receber</button>`;
    }

    slot.innerHTML = `
        <div class="appt-card-top">
            <span class="appt-status-tag ${statusAtual}">${meta.rotulo}</span>
            ${triagemPronta && statusAtual !== 'concluido' ? `<span class="badge-triagem-pronta"><i class="fa-solid fa-clipboard-check"></i> Triagem pronta</span>` : ''}
            ${agendamento.sala ? `<span class="appt-sala-tag">Sala ${escapeHTML(agendamento.sala)}</span>` : ''}
        </div>
        <p class="appt-card-nome" title="${escapeHTML(agendamento.pacNome)}">${escapeHTML(agendamento.pacNome)}</p>
        <span class="appt-card-tipo">${escapeHTML(nomeAtendimento)}${mostrarProfissional ? ` · ${escapeHTML(nomeProfissional)}` : ''}</span>
        <div class="appt-card-footer">
            ${botaoProximaEtapa}
            ${blocoFinanceiro}
        </div>
    `;

    // Cliques rápidos nos botões internos não abrem o modal de detalhe
    const btnStep = slot.querySelector('.btn-quick-step');
    if (btnStep) {
        btnStep.addEventListener('click', (e) => {
            e.stopPropagation();
            if (btnStep.classList.contains('btn-enviar-triagem')) {
                enviarTriagemParaMedico(agendamento.id);
            } else {
                alterarStatusConsultaRapido(agendamento.id, btnStep.getAttribute('data-next'));
            }
        });
    }

    const btnPay = slot.querySelector('.btn-quick-pay');
    if (btnPay) {
        btnPay.addEventListener('click', (e) => {
            e.stopPropagation();
            const notifExistente = clinicaState.notificacoes.find(n =>
                n.tipo === 'pagamento_pendente' && n.status === 'pendente' && String(n.agendamentoId) === String(agendamento.id)
            );
            abrirModalPagamento(agendamento.id, notifExistente?.id || null);
        });
    }

    slot.addEventListener('click', () => abrirModalDetalheAgendamento(agendamento.id));
}

function abrirModalDetalheAgendamento(idAgendamento) {
    const modal = document.getElementById('modal-detalhe-agendamento');
    const agendamento = clinicaState.agenda.agendamentos.find(a => String(a.id) === String(idAgendamento));
    if (!modal || !agendamento) return;

    agendamentoIdParaAtualizar = idAgendamento;

    const profissional = clinicaState.profissionais.find(p => String(p.id) === String(agendamento.profId));
    const nomeAtendimento = agendamento.procedimentoNome || agendamento.tipo || 'Consulta';
    const dataFormatada = agendamento.data ? `${agendamento.data.split('-').reverse().join('/')} às ${agendamento.hora || ''}` : '';

    const BADGE_PAGAMENTO = {
        pago: '✅ Pago no Caixa',
        pendente: '⏳ Aguardando Recebimento',
        nao_aplica: 'Sessão de Pacote / Isento'
    };

    document.getElementById('detalhe-agendamento-titulo').textContent = agendamento.pacNome || 'Consulta';
    document.getElementById('detalhe-agendamento-info').innerHTML = `
        <div class="detalhe-info-row"><span class="rotulo">Atendimento</span><span class="valor">${escapeHTML(nomeAtendimento)}</span></div>
        <div class="detalhe-info-row"><span class="rotulo">Profissional</span><span class="valor">${escapeHTML(profissional ? profissional.nome : '-')}</span></div>
        <div class="detalhe-info-row"><span class="rotulo">Data / Horário</span><span class="valor">${escapeHTML(dataFormatada)}</span></div>
        <div class="detalhe-info-row"><span class="rotulo">Sala Física</span><span class="valor">Sala ${agendamento.sala ? escapeHTML(agendamento.sala) : '-'}</span></div>
        <div class="detalhe-info-row"><span class="rotulo">Valor</span><span class="valor">${agendamento.valorAtendimento ? formatCurrency(agendamento.valorAtendimento) : '-'}</span></div>
        <div class="detalhe-info-row"><span class="rotulo">Situação no Caixa</span><span class="valor">${BADGE_PAGAMENTO[agendamento.statusPagamento] || '-'}</span></div>
    `;

    const selectStatus = document.getElementById('detalhe-agendamento-status');
    if (selectStatus) selectStatus.value = agendamento.status || 'agendado';

    const pagamentoPendente = Number(agendamento.valorAtendimento || 0) > 0 && agendamento.statusPagamento !== 'pago' && agendamento.statusPagamento !== 'nao_aplica';
    const btnPagar = document.getElementById('btn-confirmar-pagamento-detalhe');
    if (btnPagar) btnPagar.style.display = pagamentoPendente ? 'block' : 'none';

    const btnCancelar = document.getElementById('btn-cancelar-consulta-detalhe');
    if (btnCancelar) btnCancelar.style.display = agendamento.status === 'cancelado' ? 'none' : 'block';

    modal.classList.add('active');
}

export async function carregarBloqueios() {
    try {
        const q = query(
            collection(db, "bloqueios_agenda"),
            where("clinicaId", "==", clinicaState.sessao.clinicaId)
        );
        const querySnapshot = await getDocs(q);
        clinicaState.agenda.bloqueios = [];
        querySnapshot.forEach((doc) => {
            clinicaState.agenda.bloqueios.push({ ...doc.data(), id: String(doc.id) });
        });
        atualizarAgenda();
    } catch (error) {
        console.error("Erro ao buscar bloqueios da agenda: ", error);
        showToast('Erro ao carregar bloqueios de horário.', 'error');
    }
}

export async function carregarAgendamentos() {
    try {
        const q = query(
            collection(db, "agendamentos"), 
            where("clinicaId", "==", clinicaState.sessao.clinicaId)
        );
        const querySnapshot = await getDocs(q);
        clinicaState.agenda.agendamentos = [];
        querySnapshot.forEach((doc) => {
            clinicaState.agenda.agendamentos.push({ ...doc.data(), id: String(doc.id) });
        });
        atualizarAgenda(); 
    } catch (error) {
        console.error("Erro ao buscar agenda: ", error);
        showToast('Erro ao carregar agendamentos.', 'error');
    }
}