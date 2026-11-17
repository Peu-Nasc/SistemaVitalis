import { clinicaState } from './state.js';
import { showToast, comEstadoDeCarregamento, escapeHTML, confirmarAcao, formatCurrency } from './Ferramentas.js';
import { db } from './firebase.js';
import { collection, addDoc, getDocs, doc, deleteDoc, updateDoc, query, where, runTransaction } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { criarNotificacao } from './notificacoes.js';
import { registrarAuditoria } from './auditoria.js';
import { valorDoProcedimentoParaProfissional } from './procedimentos.js';

let agendamentoIdParaAtualizar = null;
let notificacaoIdEmResolucao = null;
let periodoAtual = 'dia';
let filtroStatusAtual = 'todos';
let pagamentoAdicionalConfirmado = false;
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

    const isAvulso = tipoAtendimento === 'procedimento_avulso';
    const isPacote = tipoAtendimento === 'pacote';
    grupoProcedimento.style.display = (isAvulso || isPacote) ? 'block' : 'none';
    selectProcedimento.disabled = !(isAvulso || isPacote);

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

export function initAgenda() {
    const modalAgenda = document.getElementById('modal-agendamento');
    const inputDataAgenda = document.getElementById('data-agenda');
    const filtroProfissional = document.getElementById('filtro-profissional');
    
    inputDataAgenda.value = new Date().toISOString().split('T')[0];
    
    document.getElementById('btn-novo-agendamento').addEventListener('click', () => abrirModalAgendamento());
    document.getElementById('btn-close-agendamento').addEventListener('click', () => modalAgenda.classList.remove('active'));
    
    inputDataAgenda.addEventListener('change', atualizarAgenda);
    filtroProfissional.addEventListener('change', atualizarAgenda);

    document.getElementById('agenda-data').addEventListener('change', atualizarDisponibilidadeSalas);
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

    const modalBloqueio = document.getElementById('modal-bloqueio');
    const selectTipoBloqueio = document.getElementById('bloqueio-tipo');
    const grupoHorarioEspecifico = document.getElementById('bloqueio-horario-especifico-group');

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
            const itemSelecionadoId = selectProcedimento ? selectProcedimento.value : '';

            const isPacote = tipoAtendimento === 'pacote';
            const itemObj = isPacote
                ? clinicaState.pacotes.find(p => String(p.id) === String(itemSelecionadoId))
                : clinicaState.procedimentos.find(p => String(p.id) === String(itemSelecionadoId));

            if (!itemSelecionadoId || !itemObj) {
                showToast(isPacote ? 'Selecione um pacote válido.' : 'Selecione um procedimento válido.', 'error');
                return;
            }

            const procedimentoId = itemSelecionadoId;
            const procedimento = itemObj;
            const valorAtendimento = obterValorProcedimentoSelecionado();
            const paciente = clinicaState.pacientes.find(p => String(p.id) === String(pacId));

            if (tipoAtendimento === 'procedimento_avulso' && (!procedimentoId || !procedimento)) {
                showToast('Selecione um procedimento válido para o atendimento avulso.', 'error');
                return;
            }

            if (!sala) {
                showToast('Selecione a sala onde a consulta vai acontecer.', 'error');
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
                    tipo: tipoAtendimento === 'procedimento_avulso' ? 'Procedimento avulso' : 'Sessão de Pacote',
                    procedimentoId: procedimentoId || '',
                    procedimentoNome: procedimento ? procedimento.nome : (tipoAtendimento === 'procedimento_avulso' ? 'Procedimento' : 'Sessão de Pacote'),
                    valorAtendimento: valorAtendimento,
                    statusPagamento: tipoAtendimento === 'procedimento_avulso' ? 'pendente' : 'nao_aplica',
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
            if (!ag || !ag.procedimentoId) return;
            const novoValor = valorDoProcedimentoParaProfissional(ag.procedimentoId, ag.profId, selectFormaPagamento.value);
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
    
    let profsPermitidos = clinicaState.profissionais;
    if (clinicaState.sessao.perfil === 'Doutor(a)') {
        profsPermitidos = clinicaState.profissionais.filter(p => p.nome.trim().toLowerCase() === clinicaState.sessao.nome.trim().toLowerCase());
    }

    selPac.innerHTML = clinicaState.pacientes.map(p => `<option value="${p.id}">${escapeHTML(p.nome)}</option>`).join('');
    selProf.innerHTML = profsPermitidos.map(p => `<option value="${p.id}">${escapeHTML(p.nome)} (${escapeHTML(p.especialidade)})</option>`).join('');
    
    selProf.disabled = clinicaState.sessao.perfil === 'Doutor(a)';
    
    document.getElementById('agenda-data').value = data || inputDataAgenda.value;
    document.getElementById('agenda-hora').value = hora || "08:00"; 
    if (profId) selProf.value = profId;

    adicionarBuscaAoSelect(selPac, 'paciente');
    adicionarBuscaAoSelect(selProf, 'profissional');

    const tipoAtendimento = document.getElementById('agenda-tipo');
    if (tipoAtendimento) tipoAtendimento.value = 'procedimento_avulso';

    popularSelectProcedimentos();
    document.getElementById('agenda-sala').value = '';
    atualizarDisponibilidadeSalas();
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
        profsPermitidos = clinicaState.profissionais.filter(p => p.nome.trim().toLowerCase() === clinicaState.sessao.nome.trim().toLowerCase());
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
        profsPermitidos = clinicaState.profissionais.filter(p => p.nome.trim().toLowerCase() === clinicaState.sessao.nome.trim().toLowerCase());
        mostrarTodos = false;
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

    const baseTimes = ['08:00', '09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
    const timesNoDia = new Set(baseTimes);

    clinicaState.agenda.agendamentos.forEach(a => {
        if (a.data === dataSelecionada) timesNoDia.add(a.hora);
    });
    clinicaState.agenda.bloqueios.forEach(b => {
        if (b.data === dataSelecionada && b.tipo === 'horario') timesNoDia.add(b.horaInicio);
    });

    const appointmentTimes = Array.from(timesNoDia).sort();

    colHorarios.innerHTML = `<div class="time-slot-header">Horário</div>` +
        appointmentTimes.map(h => `<div class="time-slot">${h}</div>`).join('');

    filtroProfissional.style.display = visaoAtual === 'salas' ? 'none' : '';
    container.innerHTML = '';

    const bateFiltroStatus = (ag) => filtroStatusAtual === 'todos' || (ag.status || 'agendado') === filtroStatusAtual;
    
    if (visaoAtual === 'salas' && clinicaState.sessao.perfil !== 'Doutor(a)') {
        const salasFisicas = ['1', '2', '3'];
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
        const coluna = document.createElement('div');
        coluna.className = 'professional-column';
        coluna.innerHTML = `<div class="prof-header"><strong>${escapeHTML(prof.nome)}</strong><small>${escapeHTML(prof.especialidade)}</small></div>`;
        
        appointmentTimes.forEach(hora => {
            const agendamento = clinicaState.agenda.agendamentos.find(a => 
                a.profId == prof.id && a.data === dataSelecionada && a.hora === hora && a.status !== 'cancelado' && bateFiltroStatus(a)
            );
            
            const slot = document.createElement('div');
            if (agendamento) {
                renderizarSlotOcupado(slot, agendamento);
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
        profsPermitidos = clinicaState.profissionais.filter(p => p.nome.trim().toLowerCase() === clinicaState.sessao.nome.trim().toLowerCase());
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
    let botaoProximaEtapa = '';
    if (statusAtual === 'agendado') {
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
            alterarStatusConsultaRapido(agendamento.id, btnStep.getAttribute('data-next'));
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