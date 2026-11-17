import { clinicaState } from './state.js';
import { formatCurrency, showToast, renderCardGrid, comEstadoDeCarregamento, escapeHTML, confirmarAcao, aplicarMascaraMoeda } from './Ferramentas.js';
import { db } from './firebase.js';
import { collection, addDoc, getDocs, doc, getDoc, updateDoc, deleteDoc, query, where } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { registrarAuditoria } from './auditoria.js';

let procedimentoEmEdicaoId = null;
let contadorLinhaExcecao = 0;

// Garante que o formulário de Procedimento tenha os campos de Cartão/Pix, Custo de Insumo e Profissional Vinculado
function injetarCamposExtrasNoModalProcedimento() {
    const form = document.getElementById('form-procedimento');
    const campoValorBase = document.getElementById('proc-valor');
    const selectCategoria = document.getElementById('proc-categoria');
    if (!form || !campoValorBase || document.getElementById('proc-valor-cartao')) return;

    // 1. Amplia as opções de categoria para cobrir todas as áreas da clínica
    if (selectCategoria) {
        const categoriasExtras = [
            'Ginecologia', 'Enfermagem Obstétrica', 'Biomedicina Estética',
            'Ultrassonografia', 'Dermatologia', 'Oftalmologia', 'Psiquiatria',
            'Neurologia', 'Cardiologia', 'Pediatria', 'Endocrinologia',
            'Nutrição', 'Psicopedagogia', 'Psicomotricidade', 'Musicoterapia'
        ];
        categoriasExtras.forEach(cat => {
            if (!Array.from(selectCategoria.options).some(o => o.value === cat)) {
                const opt = document.createElement('option');
                opt.value = cat;
                opt.textContent = cat;
                selectCategoria.insertBefore(opt, selectCategoria.lastElementChild);
            }
        });
    }

    // 2. Ajusta o rótulo do Valor Base para "Valor em Espécie (Dinheiro)" e cria "Valor Cartão / Pix" ao lado
    const grupoValorEsp = campoValorBase.closest('.form-group');
    if (grupoValorEsp) {
        grupoValorEsp.classList.remove('full-width');
        const label = grupoValorEsp.querySelector('label');
        if (label) label.textContent = 'Valor em Espécie (Dinheiro) *';

        const grupoCartao = document.createElement('div');
        grupoCartao.className = 'form-group';
        grupoCartao.innerHTML = `
            <label>Valor Cartão / Pix (R$)</label>
            <input type="text" id="proc-valor-cartao" class="input-premium" placeholder="0,00">
        `;
        grupoValorEsp.insertAdjacentElement('afterend', grupoCartao);
        aplicarMascaraMoeda(grupoCartao.querySelector('#proc-valor-cartao'));

        // Seletor de Tipo (Consulta, Exame, Procedimento, Avaliação) + Profissional Padrão
        const grupoVinculo = document.createElement('div');
        grupoVinculo.className = 'form-group full-width form-grid';
        grupoVinculo.style.marginTop = '4px';
        grupoVinculo.innerHTML = `
            <div class="form-group">
                <label>Tipo do Item</label>
                <select id="proc-tipo-item" class="input-premium">
                    <option value="Consulta">🩺 Consulta / Sessão</option>
                    <option value="Exame">🔬 Exame (USG, Preventivo, Retina...)</option>
                    <option value="Procedimento">💉 Procedimento / Estética / DIU</option>
                    <option value="Avaliação">📋 Anamnese / Avaliação</option>
                </select>
            </div>
            <div class="form-group">
                <label>Profissional Responsável (opcional)</label>
                <select id="proc-profissional-padrao" class="input-premium">
                    <option value="">Todos da especialidade</option>
                </select>
            </div>
        `;
        grupoCartao.insertAdjacentElement('afterend', grupoVinculo);
    }

    // 3. Adiciona campo opcional de Custo de Insumo (ex: -R$ 500 Botox antes dos 30%)
    const configSplit = document.getElementById('proc-split-config');
    if (configSplit && !document.getElementById('proc-custo-insumo')) {
        const divCusto = document.createElement('div');
        divCusto.className = 'form-group mt-10';
        divCusto.innerHTML = `
            <label>Descontar Custo de Material/Insumo antes do %? (R$ opcional)</label>
            <input type="text" id="proc-custo-insumo" class="input-premium" placeholder="Ex: 500,00 (Botox/Preenchimento)">
        `;
        configSplit.appendChild(divCusto);
        aplicarMascaraMoeda(divCusto.querySelector('#proc-custo-insumo'));
        divCusto.querySelector('#proc-custo-insumo').addEventListener('input', atualizarPreviewSplit);
    }
}

function popularSelectProfissionalPadrao(selecionadoId = '') {
    const sel = document.getElementById('proc-profissional-padrao');
    if (!sel) return;
    sel.innerHTML = '<option value="">Todos da especialidade</option>' +
        clinicaState.profissionais.map(p => `<option value="${p.id}" ${String(p.id) === String(selecionadoId) ? 'selected' : ''}>${escapeHTML(p.nome)}</option>`).join('');
}

export function initProcedimentos() {
    injetarCamposExtrasNoModalProcedimento();

    renderCardGrid('proc-mini-dash', [
        { id: 'proc-stat-total', label: 'Consultas / Exames / Procedimentos', initial: '0', variant: 'primary' },
        { id: 'proc-stat-media', label: 'Ticket Médio (Espécie)', initial: 'R$ 0,00', variant: 'success', valueClass: 'positivo' }
    ]);

    const modal = document.getElementById('modal-procedimento');
    const btnAbrir = document.getElementById('btn-abrir-modal-procedimento');
    const btnFechar = document.getElementById('btn-close-procedimento');

    if (btnAbrir) {
        btnAbrir.addEventListener('click', () => {
            injetarCamposExtrasNoModalProcedimento();
            fecharFormularioProcedimento();
            popularSelectProfissionalPadrao();
            modal.classList.add('active');
        });
    }

    if (btnFechar) {
        btnFechar.addEventListener('click', () => {
            modal.classList.remove('active');
            fecharFormularioProcedimento();
        });
    }

    const btnAddExcecao = document.getElementById('btn-add-excecao-proc');
    if (btnAddExcecao) {
        btnAddExcecao.addEventListener('click', () => adicionarLinhaExcecao());
    }

    const checkSplitAtivo = document.getElementById('proc-split-ativo');
    const containerSplit = document.getElementById('proc-split-config');
    const inputSplitPercentual = document.getElementById('proc-split-percentual');

    if (checkSplitAtivo && containerSplit) {
        checkSplitAtivo.addEventListener('change', () => {
            containerSplit.style.display = checkSplitAtivo.checked ? 'block' : 'none';
            atualizarPreviewSplit();
        });
    }
    if (inputSplitPercentual) inputSplitPercentual.addEventListener('input', atualizarPreviewSplit);
    const inputValorBase = document.getElementById('proc-valor');
    if (inputValorBase) inputValorBase.addEventListener('input', atualizarPreviewSplit);

    const search = document.getElementById('search-procedimentos');
    if (search) {
        search.addEventListener('input', (e) => atualizarTabelaProcedimentos(e.target.value.toLowerCase()));
    }

    const form = document.getElementById('form-procedimento');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btnSalvar = e.target.querySelector('button[type="submit"]');

            await comEstadoDeCarregamento(btnSalvar, 'Salvando...', async () => {
                const valorEspTexto = document.getElementById('proc-valor').value.replace(/\./g, '').replace(',', '.');
                const valorEsp = parseFloat(valorEspTexto) || 0;

                if (valorEsp <= 0) {
                    showToast('Informe um valor em espécie válido.', 'error');
                    return;
                }

                const valorCartaoTexto = (document.getElementById('proc-valor-cartao')?.value || '').replace(/\./g, '').replace(',', '.');
                const valorCartaoPix = parseFloat(valorCartaoTexto) || valorEsp;

                const custoInsumoTexto = (document.getElementById('proc-custo-insumo')?.value || '').replace(/\./g, '').replace(',', '.');
                const custoFixoInsumo = parseFloat(custoInsumoTexto) || 0;

                const profPadraoId = document.getElementById('proc-profissional-padrao')?.value || null;
                const profPadraoObj = clinicaState.profissionais.find(p => String(p.id) === String(profPadraoId));

                const excecoes = lerExcecoesDoFormulario();
                const idsRepetidos = excecoes.map(x => x.profissionalId).filter((id, i, arr) => arr.indexOf(id) !== i);
                if (idsRepetidos.length > 0) {
                    showToast('Há um profissional repetido nas exceções de valor.', 'error');
                    return;
                }

                const splitAtivo = document.getElementById('proc-split-ativo').checked;
                const percentualProfissional = splitAtivo ? (parseInt(document.getElementById('proc-split-percentual').value, 10) || 0) : null;

                const dadosParaSalvar = {
                    nome: document.getElementById('proc-nome').value.trim(),
                    categoria: document.getElementById('proc-categoria').value,
                    tipoItem: document.getElementById('proc-tipo-item')?.value || 'Procedimento',
                    valorBase: valorEsp,
                    valorEspecie: valorEsp,
                    valorCartaoPix,
                    custoFixoInsumo,
                    profissionalPadraoId: profPadraoId || null,
                    profissionalPadraoNome: profPadraoObj ? profPadraoObj.nome : null,
                    excecoes,
                    splitAtivo,
                    percentualProfissional,
                    clinicaId: clinicaState.sessao.clinicaId
                };

                try {
                    if (procedimentoEmEdicaoId) {
                        const docRef = doc(db, "procedimentos", procedimentoEmEdicaoId);
                        await updateDoc(docRef, dadosParaSalvar);
                        showToast('Procedimento atualizado com sucesso.', 'success');
                        await registrarAuditoria({ acao: 'Edição', modulo: 'Procedimentos', descricao: `Procedimento atualizado: ${dadosParaSalvar.nome}` });
                    } else {
                        await addDoc(collection(db, "procedimentos"), dadosParaSalvar);
                        showToast('Procedimento cadastrado com sucesso.', 'success');
                        await registrarAuditoria({ acao: 'Criação', modulo: 'Procedimentos', descricao: `Novo procedimento: ${dadosParaSalvar.nome}` });
                    }

                    modal.classList.remove('active');
                    fecharFormularioProcedimento();
                    await carregarProcedimentos();
                } catch (error) {
                    console.error("Erro ao salvar procedimento: ", error);
                    showToast('Falha ao salvar o procedimento.', 'error');
                }
            });
        });
    }

    const corpoTabela = document.getElementById('procedimentos-table-body');
    if (corpoTabela) {
        corpoTabela.addEventListener('click', async (e) => {
            const btnEditar = e.target.closest('.btn-editar-proc');
            const btnExcluir = e.target.closest('.btn-excluir-proc');

            if (btnExcluir) {
                const id = btnExcluir.getAttribute('data-id');
                if (await confirmarAcao('Deseja realmente excluir este item da tabela?', { titulo: 'Excluir item', textoConfirmar: 'Excluir' })) {
                    try {
                        await deleteDoc(doc(db, "procedimentos", id));
                        showToast('Item excluído com sucesso.', 'success');
                        await carregarProcedimentos();
                    } catch (error) {
                        showToast('Falha ao excluir o item.', 'error');
                    }
                }
            }

            if (btnEditar) {
                const id = btnEditar.getAttribute('data-id');
                const item = clinicaState.procedimentos.find(p => String(p.id) === String(id));
                if (item) abrirFormularioParaEdicao(item);
            }
        });
    }
}

function fecharFormularioProcedimento() {
    procedimentoEmEdicaoId = null;
    document.getElementById('form-procedimento')?.reset();
    limparListaExcecoes();
    resetarSplitParaPadrao();
}

function atualizarPreviewSplit() {
    const elPreviewProf = document.getElementById('proc-split-preview-prof');
    const elPreviewClinica = document.getElementById('proc-split-preview-clinica');
    if (!elPreviewProf || !elPreviewClinica) return;

    const percentualProf = parseInt(document.getElementById('proc-split-percentual').value, 10) || 0;
    const percentualClinica = 100 - percentualProf;

    const valorBaseTexto = document.getElementById('proc-valor').value.replace(/\./g, '').replace(',', '.');
    const valorBase = parseFloat(valorBaseTexto) || 0;

    const custoInsumoTexto = (document.getElementById('proc-custo-insumo')?.value || '').replace(/\./g, '').replace(',', '.');
    const custoInsumo = parseFloat(custoInsumoTexto) || 0;

    const baseCalculo = Math.max(0, valorBase - custoInsumo);
    const valorProf = baseCalculo * (percentualProf / 100);
    const valorClinica = (baseCalculo * (percentualClinica / 100)) + custoInsumo;

    elPreviewProf.textContent = `${percentualProf}% - ${formatCurrency(valorProf)}`;
    elPreviewClinica.textContent = `${percentualClinica}%${custoInsumo > 0 ? ' + Insumo' : ''} - ${formatCurrency(valorClinica)}`;
}

function resetarSplitParaPadrao() {
    const checkSplitAtivo = document.getElementById('proc-split-ativo');
    const containerSplit = document.getElementById('proc-split-config');
    const inputSplitPercentual = document.getElementById('proc-split-percentual');
    const inputCustoInsumo = document.getElementById('proc-custo-insumo');

    if (checkSplitAtivo) checkSplitAtivo.checked = true;
    if (containerSplit) containerSplit.style.display = 'block';
    if (inputSplitPercentual) inputSplitPercentual.value = 70; // Padrão Clínica Amora: 70% Prof / 30% Clínica
    if (inputCustoInsumo) inputCustoInsumo.value = '';
    atualizarPreviewSplit();
}

function limparListaExcecoes() {
    const lista = document.getElementById('proc-excecoes-lista');
    if (lista) lista.innerHTML = '';
}

function adicionarLinhaExcecao(profissionalIdSelecionado = '', valorPreenchido = '') {
    const lista = document.getElementById('proc-excecoes-lista');
    if (!lista) return;

    const linhaId = `proc-excecao-${contadorLinhaExcecao++}`;
    const linha = document.createElement('div');
    linha.className = 'flex-row gap-15 mb-10';
    linha.id = linhaId;
    linha.innerHTML = `
        <select class="input-premium excecao-profissional" style="flex: 2;">
            <option value="">Selecione o profissional...</option>
            ${clinicaState.profissionais.map(p => `<option value="${p.id}" ${String(p.id) === String(profissionalIdSelecionado) ? 'selected' : ''}>${escapeHTML(p.nome)}</option>`).join('')}
        </select>
        <input type="text" class="input-premium excecao-valor" placeholder="0,00" style="flex: 1;" value="${valorPreenchido}">
        <button type="button" class="btn-action btn-delete btn-remover-excecao" title="Remover exceção"><i class="fa-solid fa-xmark"></i></button>
    `;
    lista.appendChild(linha);

    aplicarMascaraMoeda(linha.querySelector('.excecao-valor'));
    linha.querySelector('.btn-remover-excecao').addEventListener('click', () => linha.remove());
}

function lerExcecoesDoFormulario() {
    const linhas = document.querySelectorAll('#proc-excecoes-lista > div');
    const excecoes = [];

    linhas.forEach(linha => {
        const selectProf = linha.querySelector('.excecao-profissional');
        const inputValor = linha.querySelector('.excecao-valor');
        const profissionalId = selectProf ? selectProf.value : '';
        const valorTexto = inputValor ? inputValor.value.replace(/\./g, '').replace(',', '.') : '';

        if (!profissionalId || !valorTexto || parseFloat(valorTexto) <= 0) return;

        const profissional = clinicaState.profissionais.find(p => String(p.id) === String(profissionalId));
        excecoes.push({
            profissionalId,
            profissionalNome: profissional ? profissional.nome : '',
            valor: parseFloat(valorTexto)
        });
    });

    return excecoes;
}

function abrirFormularioParaEdicao(item) {
    injetarCamposExtrasNoModalProcedimento();
    procedimentoEmEdicaoId = item.id;

    document.getElementById('proc-nome').value = item.nome;
    document.getElementById('proc-categoria').value = item.categoria || 'Outro';
    if (document.getElementById('proc-tipo-item')) {
        document.getElementById('proc-tipo-item').value = item.tipoItem || 'Procedimento';
    }
    popularSelectProfissionalPadrao(item.profissionalPadraoId || '');

    const valorEsp = Number(item.valorEspecie ?? item.valorBase) || 0;
    const valorPix = Number(item.valorCartaoPix ?? valorEsp) || 0;
    const custoInsumo = Number(item.custoFixoInsumo || 0);

    document.getElementById('proc-valor').value = valorEsp.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    if (document.getElementById('proc-valor-cartao')) {
        document.getElementById('proc-valor-cartao').value = valorPix.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    }
    if (document.getElementById('proc-custo-insumo')) {
        document.getElementById('proc-custo-insumo').value = custoInsumo > 0 ? custoInsumo.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '';
    }

    limparListaExcecoes();
    (item.excecoes || []).forEach(x => {
        const valorExcecao = Number(x.valor) || 0;
        adicionarLinhaExcecao(x.profissionalId, valorExcecao.toLocaleString('pt-BR', { minimumFractionDigits: 2 }));
    });

    const checkSplitAtivo = document.getElementById('proc-split-ativo');
    const containerSplit = document.getElementById('proc-split-config');
    checkSplitAtivo.checked = !!item.splitAtivo;
    containerSplit.style.display = item.splitAtivo ? 'block' : 'none';
    document.getElementById('proc-split-percentual').value = item.splitAtivo ? (item.percentualProfissional ?? 70) : 70;
    atualizarPreviewSplit();

    document.getElementById('modal-procedimento').classList.add('active');
}

export function atualizarTabelaProcedimentos(filtro = '') {
    const corpo = document.getElementById('procedimentos-table-body');
    if (!corpo) return;

    const filtrados = clinicaState.procedimentos.filter(p =>
        (p.nome || '').toLowerCase().includes(filtro) ||
        (p.categoria || '').toLowerCase().includes(filtro) ||
        (p.profissionalPadraoNome || '').toLowerCase().includes(filtro) ||
        (p.tipoItem || '').toLowerCase().includes(filtro)
    );

    corpo.innerHTML = filtrados.map(p => {
        const vEspecie = Number(p.valorEspecie ?? p.valorBase ?? 0);
        const vCartao = Number(p.valorCartaoPix ?? vEspecie);
        const custoInsumo = Number(p.custoFixoInsumo || 0);

        const { valorProfissional, valorClinica, percentualProfissional } = splitDoProcedimento(p.id, vEspecie);
        const percClinica = 100 - percentualProfissional;

        const textoSplit = p.splitAtivo
            ? `<small>Prof (${percentualProfissional}%): <strong>${formatCurrency(valorProfissional)}</strong><br>Clínica (${percClinica}%${custoInsumo > 0 ? ` + R$ ${custoInsumo} insumo` : ''}): <strong>${formatCurrency(valorClinica)}</strong></small>`
            : '<span style="color:#6C757D;">100% Clínica</span>';

        const profVinculado = p.profissionalPadraoNome
            ? `<span class="badge neutral">${escapeHTML(p.profissionalPadraoNome)}</span>`
            : '<span style="color:#6C757D;">Geral da Especialidade</span>';

        return `<tr>
            <td>
                <strong>${escapeHTML(p.nome)}</strong><br>
                <small style="color:var(--text-light);">${escapeHTML(p.tipoItem || 'Procedimento')}</small>
            </td>
            <td><span class="badge primary">${escapeHTML(p.categoria || 'Geral')}</span></td>
            <td>
                <span class="positivo valor-lancamento" title="Pagamento em Espécie">${formatCurrency(vEspecie)} <small>(Espécie)</small></span><br>
                <small style="color:var(--primary-color); font-weight:600;">💳 Cartão/Pix: ${formatCurrency(vCartao)}</small>
            </td>
            <td>${textoSplit}</td>
            <td>${profVinculado}</td>
            <td>
                <div class="row-actions">
                    <button class="btn-action btn-edit btn-editar-proc" data-id="${p.id}" title="Editar">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="btn-action btn-delete btn-excluir-proc" data-id="${p.id}" title="Excluir">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>`;
    }).join('');

    if (filtrados.length === 0) {
        corpo.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#6C757D; padding:20px;">Nenhum procedimento ou exame encontrado.</td></tr>';
    }

    const elTotal = document.getElementById('proc-stat-total');
    const elMedia = document.getElementById('proc-stat-media');
    if (elTotal) elTotal.textContent = clinicaState.procedimentos.length;
    if (elMedia) {
        const media = clinicaState.procedimentos.length > 0
            ? clinicaState.procedimentos.reduce((soma, p) => soma + Number(p.valorEspecie ?? p.valorBase ?? 0), 0) / clinicaState.procedimentos.length
            : 0;
        elMedia.textContent = formatCurrency(media);
    }
}

// Retorna o valor certo conforme o profissional e a forma de pagamento ('Dinheiro' vs 'Pix'/'Credito'/'Debito')
export function valorDoProcedimentoParaProfissional(procedimentoId, profissionalId, formaPagamento = 'Dinheiro') {
    const proc = clinicaState.procedimentos.find(p => String(p.id) === String(procedimentoId));
    if (!proc) {
        // Verifica se é um pacote selecionado na Agenda
        const pac = clinicaState.pacotes.find(x => String(x.id) === String(procedimentoId));
        if (!pac) return 0;
        const ehEspeciePac = formaPagamento === 'Dinheiro';
        return Number(ehEspeciePac ? (pac.valorEspecie ?? pac.valorFechado) : (pac.valorCartaoPix ?? pac.valorFechado)) || 0;
    }

    const excecao = (proc.excecoes || []).find(x => String(x.profissionalId) === String(profissionalId));
    if (excecao) return Number(excecao.valor) || 0;

    const ehEspecie = formaPagamento === 'Dinheiro';
    const valor = ehEspecie
        ? (proc.valorEspecie ?? proc.valorBase)
        : (proc.valorCartaoPix ?? proc.valorBase);
    return Number(valor) || 0;
}

// Calcula o repasse respeitando a dedução de insumo (ex: -R$ 500 Botox Dra. Seridianny antes dos 30%)
export function splitDoProcedimento(procedimentoId, valorConsulta) {
    const proc = clinicaState.procedimentos.find(p => String(p.id) === String(procedimentoId))
        || clinicaState.pacotes.find(p => String(p.id) === String(procedimentoId));
    const valor = Number(valorConsulta) || 0;

    if (!proc || !proc.splitAtivo) {
        return { valorProfissional: valor, valorClinica: 0, percentualProfissional: 100 };
    }

    const custoInsumo = Number(proc.custoFixoInsumo || 0);
    const baseLiquida = Math.max(0, valor - custoInsumo);
    const percentualProfissional = proc.percentualProfissional ?? 70;

    const valorProfissional = baseLiquida * (percentualProfissional / 100);
    const valorClinica = valor - valorProfissional;

    return { valorProfissional, valorClinica, percentualProfissional };
}

export async function carregarProcedimentos() {
    try {
        const q = query(
            collection(db, "procedimentos"),
            where("clinicaId", "==", clinicaState.sessao.clinicaId)
        );
        const querySnapshot = await getDocs(q);

        clinicaState.procedimentos = [];
        querySnapshot.forEach((doc) => {
            clinicaState.procedimentos.push({ ...doc.data(), id: String(doc.id) });
        });

        clinicaState.procedimentos.sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
        atualizarTabelaProcedimentos();
    } catch (error) {
        console.error("Erro ao buscar procedimentos: ", error);
        showToast('Erro ao carregar a tabela de procedimentos.', 'error');
    }
}