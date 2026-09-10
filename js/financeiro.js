import { clinicaState } from './state.js';
import { formatCurrency, showToast, renderCardGrid, comEstadoDeCarregamento, escapeHTML, confirmarAcao } from './Ferramentas.js';
import { db } from './firebase.js';
import { collection, addDoc, getDocs, doc, updateDoc, deleteDoc, query, where } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { registrarAuditoria } from './auditoria.js';

let lancamentoEmEdicaoId = null;
let dreChartInstance = null;
let chartReceitaDespesaInstance = null;
let chartDespesaCategoriaInstance = null;
let chartReceitaPagamentoInstance = null;
let chartReceitaProfissionalInstance = null;
let custoFixoEmEdicaoId = null;

const CATEGORIAS_CUSTO_FIXO = {
    'Aluguel': 'Aluguel',
    'Salarios': 'Salários',
    'Contas': 'Água / Luz / Internet',
    'Insumos': 'Insumos Recorrentes',
    'Manutencao': 'Manutenção',
    'Outros': 'Outros'
};

export function initFinanceiro() {
    // Monta os cards dos dois mini-dashboards controlados por este módulo
    // (Performance Financeira do Dashboard principal + Livro Caixa)
    renderCardGrid('dash-mini-dash', [
        { id: 'dash-receitas', label: 'Receitas Liquidadas', initial: 'R$ 0,00', variant: 'success', valueClass: 'positivo' },
        { id: 'dash-despesas', label: 'Despesas / Custos', initial: 'R$ 0,00', variant: 'danger', valueClass: 'negativo' },
        { id: 'dash-glosas', label: 'Glosas Médicas', initial: 'R$ 0,00', variant: 'warning', valueClass: 'warning' },
        { id: 'dash-lucro', label: 'Lucro Líquido (DRE)', initial: 'R$ 0,00', variant: 'primary', valueClass: 'total' }
    ]);

    renderCardGrid('fin-mini-dash', [
        { id: 'fin-stat-receitas', label: 'Entradas (Receitas)', initial: 'R$ 0,00', variant: 'success', valueClass: 'positivo', compact: true },
        { id: 'fin-stat-despesas', label: 'Saídas (Despesas)', initial: 'R$ 0,00', variant: 'danger', valueClass: 'negativo', compact: true },
        { id: 'fin-stat-saldo', label: 'Saldo do Filtro Atual', initial: 'R$ 0,00', variant: 'primary', valueClass: 'total', compact: true }
    ]);

    // ==========================================
    // FORMULÁRIO SIMPLIFICADO DA RECEPÇÃO
    // Tela própria (não é o Livro Caixa completo) - só escolhe o tipo,
    // preenche e registra. Sem lista, sem totais, sem filtro. Data
    // (competência/caixa) e status são preenchidos automaticamente porque,
    // pra recepção, o lançamento é sempre algo que já aconteceu hoje.
    // ==========================================
    const formFinRecepcao = document.getElementById('form-financeiro-recepcao');
    if (formFinRecepcao) {
        formFinRecepcao.addEventListener('submit', async (e) => {
            e.preventDefault();

            const btnSalvar = e.target.querySelector('button[type="submit"]');
            const valorInput = document.getElementById('fr-valor').value.replace(/\./g, '').replace(',', '.');

            if (!valorInput || parseFloat(valorInput) <= 0) {
                showToast('Informe um valor válido.', 'error');
                return;
            }

            await comEstadoDeCarregamento(btnSalvar, 'Registrando...', async () => {
                const hoje = new Date().toISOString().split('T')[0];
                const dadosParaSalvar = {
                    tipo: document.getElementById('fr-tipo').value,
                    vinculo: document.getElementById('fr-vinculo').value,
                    pagamento: document.getElementById('fr-pagamento').value,
                    status: 'Recebido/Pago',
                    competencia: hoje,
                    caixa: hoje,
                    valor: parseFloat(valorInput),
                    profissionalId: null,
                    profissionalNome: null,
                    clinicaId: clinicaState.sessao.clinicaId
                };

                try {
                    await addDoc(collection(db, "financeiro"), dadosParaSalvar);
                    showToast('Lançamento registrado com sucesso!', 'success');
                    await registrarAuditoria({ acao: 'Criação', modulo: 'Financeiro', descricao: `Novo lançamento (recepção): ${dadosParaSalvar.vinculo} - ${formatCurrency(dadosParaSalvar.valor)} (${dadosParaSalvar.tipo})` });

                    e.target.reset();
                    await carregarFinanceiro();
                } catch (error) {
                    console.error("Erro ao registrar lançamento (recepção): ", error);
                    showToast('Falha de conexão ao registrar. Tente novamente.', 'error');
                }
            });
        });
    }

    const modalFinanceiro = document.getElementById('modal-financeiro');
    
    document.getElementById('btn-abrir-modal-financeiro').addEventListener('click', () => {
        const hoje = new Date().toISOString().split('T')[0];
        document.getElementById('fin-competencia').value = hoje;
        document.getElementById('fin-caixa').value = hoje;

        const selProf = document.getElementById('fin-profissional');
        if (selProf) {
            selProf.innerHTML = '<option value="">Nenhum / Geral da clínica</option>' +
                clinicaState.profissionais.map(p => `<option value="${p.id}">${escapeHTML(p.nome)}</option>`).join('');
        }

        const finTipo = document.getElementById('fin-tipo');
        // Recepção lança entradas e despesas do dia a dia, mas o repasse aos
        // profissionais é sensível (envolve remuneração médica) e continua
        // exclusivo do Administrador.
        if (clinicaState.sessao.perfil === 'recepcao') {
            finTipo.innerHTML = `
                <option value="Receita">📥 Entrada (Receita)</option>
                <option value="Custo Fixo">📤 Saída (Custo Fixo)</option>
                <option value="Custo Variavel">📤 Saída (Custo Variável / Materiais)</option>
            `;
        } else {
            // Administrador vê todas as opções de entrada e saída
            finTipo.innerHTML = `
                <option value="Receita">📥 Entrada (Receita)</option>
                <option value="Custo Fixo">📤 Saída (Custo Fixo)</option>
                <option value="Custo Variavel">📤 Saída (Custo Variável / Materiais)</option>
                <option value="Repasse">📤 Saída (Repasse Médico)</option>
            `;
        }

        // Atalho de Pacotes é resetado a cada abertura do modal (evita
        // manter um pacote "escolhido" de um lançamento anterior)
        const selPacote = document.getElementById('fin-pacote-atalho');
        if (selPacote) selPacote.value = '';

        modalFinanceiro.classList.add('active');
    });

    document.getElementById('btn-close-financeiro').addEventListener('click', () => modalFinanceiro.classList.remove('active'));

    // ========================================================
    // ATALHO DE PACOTES NO LANÇAMENTO
    // Ao escolher um pacote, pré-preenche Tipo=Receita, Vínculo e Valor -
    // continua editável (o nome do paciente, principalmente, precisa ser
    // digitado/ajustado por quem está lançando).
    // ========================================================
    const selPacoteAtalho = document.getElementById('fin-pacote-atalho');
    if (selPacoteAtalho) {
        selPacoteAtalho.addEventListener('change', (e) => {
            const pacoteId = e.target.value;
            if (!pacoteId) return;

            const pacote = clinicaState.pacotes.find(p => String(p.id) === String(pacoteId));
            if (!pacote) return;

            document.getElementById('fin-tipo').value = 'Receita';
            document.getElementById('fin-vinculo').value = `Pacote: ${pacote.nome} - `;
            document.getElementById('fin-valor').value = pacote.valorFechado.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
            document.getElementById('fin-vinculo').focus();
        });
    }

    // ========================================================
    // LISTENERS DO DASHBOARD PRINCIPAL
    // ========================================================
    const filtroPeriodo = document.getElementById('dash-filtro-periodo');
    const filtroDataEsp = document.getElementById('dash-data-especifica');

    if (filtroPeriodo) {
        filtroPeriodo.addEventListener('change', (e) => {
            if (e.target.value === 'especifico') {
                filtroDataEsp.style.display = 'block';
                if (!filtroDataEsp.value) {
                    const hoje = new Date();
                    filtroDataEsp.value = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
                }
            } else {
                filtroDataEsp.style.display = 'none';
            }
            calcularDRE(); 
        });
    }

    if (filtroDataEsp) {
        filtroDataEsp.addEventListener('change', calcularDRE);
    }

    // ========================================================
    // NOVO: LISTENERS DO FILTRO LOCAL (Aba Financeiro)
    // ========================================================
    const searchFin = document.getElementById('search-financeiro');
    const mesFin = document.getElementById('filtro-mes-financeiro');

    if (searchFin) {
        searchFin.addEventListener('input', (e) => {
            atualizarTabelaFinanceiro(e.target.value.toLowerCase(), mesFin ? mesFin.value : 'todos');
        });
    }
    if (mesFin) {
        mesFin.addEventListener('change', (e) => {
            atualizarTabelaFinanceiro(searchFin ? searchFin.value.toLowerCase() : '', e.target.value);
        });
    }

    const btnExportarExcel = document.getElementById('btn-exportar-financeiro');
    if (btnExportarExcel) {
        btnExportarExcel.addEventListener('click', exportarFinanceiroExcel);
    }

    // ========================================================
    // FORMULÁRIO DE LANÇAMENTOS
    // ========================================================
    document.getElementById('form-financeiro').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const btnSalvar = e.target.querySelector('button[type="submit"]');

        await comEstadoDeCarregamento(btnSalvar, 'Lançando...', async () => {
            let valorInput = document.getElementById('fin-valor').value;
            if (typeof valorInput === 'string') {
                valorInput = valorInput.replace(/\./g, '').replace(',', '.');
            }

            try {
                // Trava real (não só de UI): mesmo que a recepção tente forçar
                // o campo Tipo via DevTools, o salvamento recusa Repasse Médico
                // pra esse perfil - é o único tipo que continua exclusivo do
                // Administrador (envolve remuneração de profissionais).
                const tipoSelecionado = document.getElementById('fin-tipo').value;
                if (clinicaState.sessao.perfil === 'recepcao' && tipoSelecionado === 'Repasse') {
                    showToast('Repasse Médico é restrito ao Administrador.', 'error');
                    return;
                }

                const profSelecionado = clinicaState.profissionais.find(p => String(p.id) === String(document.getElementById('fin-profissional').value));

                const dadosParaSalvar = {
                    tipo: document.getElementById('fin-tipo').value,
                    vinculo: document.getElementById('fin-vinculo').value,
                    pagamento: document.getElementById('fin-pagamento').value,
                    status: document.getElementById('fin-status').value,
                    competencia: document.getElementById('fin-competencia').value,
                    caixa: document.getElementById('fin-caixa').value,
                    valor: parseFloat(valorInput),
                    profissionalId: profSelecionado ? profSelecionado.id : null,
                    profissionalNome: profSelecionado ? profSelecionado.nome : null,
                    clinicaId: clinicaState.sessao.clinicaId
                };

                if (lancamentoEmEdicaoId) {
                    await updateDoc(doc(db, "financeiro", lancamentoEmEdicaoId), dadosParaSalvar);
                    showToast('Lançamento atualizado e DRE recalculada!', 'success');
                    await registrarAuditoria({ acao: 'Edição', modulo: 'Financeiro', descricao: `Lançamento atualizado: ${dadosParaSalvar.vinculo} - ${formatCurrency(dadosParaSalvar.valor)} (${dadosParaSalvar.tipo})` });
                } else {
                    await addDoc(collection(db, "financeiro"), dadosParaSalvar);
                    showToast('Lançamento registrado na nuvem com sucesso.', 'success');
                    await registrarAuditoria({ acao: 'Criação', modulo: 'Financeiro', descricao: `Novo lançamento: ${dadosParaSalvar.vinculo} - ${formatCurrency(dadosParaSalvar.valor)} (${dadosParaSalvar.tipo})` });
                }
                
                modalFinanceiro.classList.remove('active');
                e.target.reset();
                lancamentoEmEdicaoId = null; 
                
                await carregarFinanceiro(); 
                
            } catch (error) {
                console.error("Erro no caixa: ", error);
                showToast('Falha ao registrar lançamento financeiro.', 'error');
            }
        });
    });

    const financeTableBody = document.getElementById('finance-table-body');
    if (financeTableBody) {
        financeTableBody.addEventListener('click', async (e) => {
            // Trava real (não só visual): mesmo que o botão de editar/excluir
            // acabe aparecendo por algum outro caminho, a recepção não pode
            // mexer em lançamento já feito - só o Administrador.
            if (clinicaState.sessao.perfil === 'recepcao') return;

            const btnEditar = e.target.closest('.btn-editar-fin');
            const btnExcluir = e.target.closest('.btn-excluir-fin');

            if (btnExcluir) {
                const idFin = btnExcluir.getAttribute('data-id');
                if (await confirmarAcao('Deseja realmente excluir este lançamento financeiro? Essa ação recalculará a sua DRE imediatamente.', { titulo: 'Excluir lançamento', textoConfirmar: 'Excluir' })) {
                    const lancExcluido = clinicaState.financeiro.lancamentos.find(l => String(l.id) === String(idFin));
                    try {
                        await deleteDoc(doc(db, "financeiro", idFin));
                        showToast('Lançamento excluído com sucesso.', 'success');
                        await registrarAuditoria({ acao: 'Exclusão', modulo: 'Financeiro', descricao: `Lançamento excluído: ${lancExcluido ? lancExcluido.vinculo + ' - ' + formatCurrency(lancExcluido.valor) : idFin}` });
                        await carregarFinanceiro();
                    } catch (error) {
                        console.error("Erro ao excluir: ", error);
                        showToast('Falha ao excluir lançamento.', 'error');
                    }
                }
            }

            if (btnEditar) {
                const idFin = btnEditar.getAttribute('data-id');
                const lancamento = clinicaState.financeiro.lancamentos.find(l => String(l.id) === String(idFin));
                
                if (lancamento) {
                    lancamentoEmEdicaoId = lancamento.id; 
                    
                    document.getElementById('fin-tipo').value = lancamento.tipo;
                    document.getElementById('fin-vinculo').value = lancamento.vinculo;
                    document.getElementById('fin-pagamento').value = lancamento.pagamento;
                    document.getElementById('fin-status').value = lancamento.status;
                    document.getElementById('fin-competencia').value = lancamento.competencia;
                    document.getElementById('fin-caixa').value = lancamento.caixa;
                    
                    document.getElementById('fin-valor').value = lancamento.valor.toLocaleString('pt-BR', { minimumFractionDigits: 2 });

                    const selProf = document.getElementById('fin-profissional');
                    if (selProf) {
                        selProf.innerHTML = '<option value="">Nenhum / Geral da clínica</option>' +
                            clinicaState.profissionais.map(p => `<option value="${p.id}">${escapeHTML(p.nome)}</option>`).join('');
                        selProf.value = lancamento.profissionalId || '';
                    }
                    
                    document.getElementById('modal-financeiro').classList.add('active');
                }
            }
        });
    }

    document.getElementById('btn-close-financeiro').addEventListener('click', () => {
        document.getElementById('modal-financeiro').classList.remove('active');
        lancamentoEmEdicaoId = null; 
        document.getElementById('form-financeiro').reset();
    });

    initCustosFixos();
}

// ========================================================
// CUSTOS FIXOS (aluguel, salários, insumos recorrentes)
// ========================================================
function initCustosFixos() {
    renderCardGrid('custo-fixo-mini-dash', [
        { id: 'custo-fixo-stat-total', label: 'Total Mensal Fixo', initial: 'R$ 0,00', variant: 'danger', valueClass: 'negativo' },
        { id: 'custo-fixo-stat-qtd', label: 'Custos Cadastrados', initial: '0', variant: 'primary' }
    ]);

    const modalCustoFixo = document.getElementById('modal-custo-fixo');

    document.getElementById('btn-abrir-modal-custo-fixo').addEventListener('click', () => {
        modalCustoFixo.classList.add('active');
    });

    document.getElementById('btn-close-custo-fixo').addEventListener('click', () => {
        modalCustoFixo.classList.remove('active');
        custoFixoEmEdicaoId = null;
        document.getElementById('form-custo-fixo').reset();
    });

    document.getElementById('form-custo-fixo').addEventListener('submit', async (e) => {
        e.preventDefault();

        const btnSalvar = e.target.querySelector('button[type="submit"]');

        await comEstadoDeCarregamento(btnSalvar, 'Salvando...', async () => {
            let valorInput = document.getElementById('custo-valor').value;
            if (typeof valorInput === 'string') {
                valorInput = valorInput.replace(/\./g, '').replace(',', '.');
            }

            try {
                const dadosParaSalvar = {
                    descricao: document.getElementById('custo-descricao').value,
                    categoria: document.getElementById('custo-categoria').value,
                    diaVencimento: parseInt(document.getElementById('custo-dia-vencimento').value),
                    valor: parseFloat(valorInput),
                    clinicaId: clinicaState.sessao.clinicaId
                };

                if (custoFixoEmEdicaoId) {
                    await updateDoc(doc(db, "custosFixos", custoFixoEmEdicaoId), dadosParaSalvar);
                    showToast('Custo fixo atualizado com sucesso.', 'success');
                    await registrarAuditoria({ acao: 'Edição', modulo: 'Custos Fixos', descricao: `Custo fixo atualizado: ${dadosParaSalvar.descricao} - ${formatCurrency(dadosParaSalvar.valor)}` });
                } else {
                    await addDoc(collection(db, "custosFixos"), dadosParaSalvar);
                    showToast('Custo fixo cadastrado com sucesso.', 'success');
                    await registrarAuditoria({ acao: 'Criação', modulo: 'Custos Fixos', descricao: `Novo custo fixo: ${dadosParaSalvar.descricao} - ${formatCurrency(dadosParaSalvar.valor)}` });
                }

                modalCustoFixo.classList.remove('active');
                e.target.reset();
                custoFixoEmEdicaoId = null;

                await carregarCustosFixos();

            } catch (error) {
                console.error("Erro nos custos fixos: ", error);
                showToast('Falha ao registrar custo fixo.', 'error');
            }
        });
    });

    const custoFixoTableBody = document.getElementById('custo-fixo-table-body');
    if (custoFixoTableBody) {
        custoFixoTableBody.addEventListener('click', async (e) => {
            const btnEditar = e.target.closest('.btn-editar-custo-fixo');
            const btnExcluir = e.target.closest('.btn-excluir-custo-fixo');

            if (btnExcluir) {
                const idCusto = btnExcluir.getAttribute('data-id');
                if (await confirmarAcao('Deseja realmente excluir este custo fixo?', { titulo: 'Excluir custo fixo', textoConfirmar: 'Excluir' })) {
                    const custoExcluido = clinicaState.financeiro.custosFixos.find(c => String(c.id) === String(idCusto));
                    try {
                        await deleteDoc(doc(db, "custosFixos", idCusto));
                        showToast('Custo fixo excluído com sucesso.', 'success');
                        await registrarAuditoria({ acao: 'Exclusão', modulo: 'Custos Fixos', descricao: `Custo fixo excluído: ${custoExcluido ? custoExcluido.descricao : idCusto}` });
                        await carregarCustosFixos();
                    } catch (error) {
                        console.error("Erro ao excluir custo fixo: ", error);
                        showToast('Falha ao excluir custo fixo.', 'error');
                    }
                }
            }

            if (btnEditar) {
                const idCusto = btnEditar.getAttribute('data-id');
                const custo = clinicaState.financeiro.custosFixos.find(c => String(c.id) === String(idCusto));

                if (custo) {
                    custoFixoEmEdicaoId = custo.id;

                    document.getElementById('custo-descricao').value = custo.descricao;
                    document.getElementById('custo-categoria').value = custo.categoria;
                    document.getElementById('custo-dia-vencimento').value = custo.diaVencimento;
                    document.getElementById('custo-valor').value = custo.valor.toLocaleString('pt-BR', { minimumFractionDigits: 2 });

                    modalCustoFixo.classList.add('active');
                }
            }
        });
    }
}

export function atualizarTabelaCustosFixos() {
    const corpoTabela = document.getElementById('custo-fixo-table-body');
    if (!corpoTabela) return;

    const custos = clinicaState.financeiro.custosFixos.slice().sort((a, b) => a.diaVencimento - b.diaVencimento);
    let totalMensal = 0;

    corpoTabela.innerHTML = custos.map(c => {
        totalMensal += c.valor;

        return `<tr>
            <td><strong>${escapeHTML(c.descricao)}</strong></td>
            <td><span class="badge info">${escapeHTML(CATEGORIAS_CUSTO_FIXO[c.categoria] || c.categoria)}</span></td>
            <td>Todo dia ${c.diaVencimento}</td>
            <td class="negativo valor-lancamento">${formatCurrency(c.valor)}</td>
            <td>
                <div class="row-actions">
                    <button class="btn-action btn-edit btn-editar-custo-fixo" data-id="${c.id}" title="Editar">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="btn-action btn-delete btn-excluir-custo-fixo" data-id="${c.id}" title="Excluir">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>`;
    }).join('');

    const elTotal = document.getElementById('custo-fixo-stat-total');
    const elQtd = document.getElementById('custo-fixo-stat-qtd');

    if (elTotal) elTotal.textContent = formatCurrency(totalMensal);
    if (elQtd) elQtd.textContent = custos.length;
}

export async function carregarCustosFixos() {
    try {
        const q = query(
            collection(db, "custosFixos"),
            where("clinicaId", "==", clinicaState.sessao.clinicaId)
        );
        const querySnapshot = await getDocs(q);

        clinicaState.financeiro.custosFixos = [];

        querySnapshot.forEach((doc) => {
            clinicaState.financeiro.custosFixos.push({
                ...doc.data(),
                id: String(doc.id)
            });
        });

        atualizarTabelaCustosFixos();

    } catch (error) {
        console.error("Erro ao buscar custos fixos: ", error);
        showToast('Erro ao carregar os custos fixos.', 'error');
    }
}

// NOVA DRE INTELIGENTE (Com filtros de data para o Dashboard principal)
export function calcularDRE() {
    const filtroPeriodo = document.getElementById('dash-filtro-periodo') ? document.getElementById('dash-filtro-periodo').value : 'mes';
    const dataEspecifica = document.getElementById('dash-data-especifica') ? document.getElementById('dash-data-especifica').value : '';

    const getIsoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    
    const hojeObj = new Date();
    const hojeIso = getIsoDate(hojeObj);

    const ontemObj = new Date(hojeObj);
    ontemObj.setDate(ontemObj.getDate() - 1);
    const ontemIso = getIsoDate(ontemObj);

    const semanaObj = new Date(hojeObj);
    semanaObj.setDate(semanaObj.getDate() - 7);
    const semanaIso = getIsoDate(semanaObj);

    const mesObj = new Date(hojeObj);
    mesObj.setDate(mesObj.getDate() - 30);
    const mesIso = getIsoDate(mesObj);

    const dataDentroDoFiltro = (dataAComparar) => {
        if (!dataAComparar) return false;
        switch(filtroPeriodo) {
            case 'hoje': return dataAComparar === hojeIso;
            case 'ontem': return dataAComparar === ontemIso;
            case 'semana': return dataAComparar >= semanaIso && dataAComparar <= hojeIso;
            case 'mes': return dataAComparar >= mesIso && dataAComparar <= hojeIso;
            case 'especifico': return dataAComparar === dataEspecifica;
            case 'tudo': return true;
            default: return true;
        }
    };

    let receitas = 0, despesas = 0, glosas = 0, inadimplente = 0, totalFaturado = 0;
    
    clinicaState.financeiro.lancamentos.forEach(l => {
        if (!dataDentroDoFiltro(l.competencia)) return;

        totalFaturado += l.valor; 
        
        if (l.status === 'Recebido/Pago') {
            if (l.tipo === 'Receita') receitas += l.valor;
            else despesas += l.valor;
        } else if (l.status === 'Glosa') {
            glosas += l.valor;
        } else if (l.status === 'Inadimplente') {
            inadimplente += l.valor;
        }
    });
    
    const lucro = receitas - despesas;
    
    const tituloDRE = document.getElementById('dash-titulo-financeiro');
    const nomesFiltros = {
        'hoje': 'Apenas Hoje', 'ontem': 'Ontem', 'semana': 'Últimos 7 Dias', 
        'mes': 'Últimos 30 Dias', 'tudo': 'Todo o Histórico', 'especifico': 'Data Específica'
    };
    if (tituloDRE) tituloDRE.innerHTML = `Performance Financeira (${nomesFiltros[filtroPeriodo]})`;

    const dashRec = document.getElementById('dash-receitas');
    const dashDesp = document.getElementById('dash-despesas');
    const dashGlosas = document.getElementById('dash-glosas');
    const dashLucro = document.getElementById('dash-lucro');
    
    if(dashRec) dashRec.textContent = formatCurrency(receitas);
    if(dashDesp) dashDesp.textContent = formatCurrency(despesas);
    if(dashGlosas) dashGlosas.textContent = formatCurrency(glosas);
    if(dashLucro) {
        dashLucro.textContent = formatCurrency(lucro);
        dashLucro.style.color = lucro < 0 ? '#dc3545' : 'var(--primary-color)';
    }

    const txInad = totalFaturado > 0 ? ((inadimplente / totalFaturado) * 100).toFixed(1) : 0;
    const txGlosa = totalFaturado > 0 ? ((glosas / totalFaturado) * 100).toFixed(1) : 0;

    const elTxInad = document.getElementById('dash-tx-inad');
    const elBarInad = document.getElementById('dash-bar-inad');
    if (elTxInad) elTxInad.textContent = `${txInad}%`;
    if (elBarInad) elBarInad.style.width = `${txInad}%`;

    const elTxGlosa = document.getElementById('dash-tx-glosa');
    const elBarGlosa = document.getElementById('dash-bar-glosa');
    if (elTxGlosa) elTxGlosa.textContent = `${txGlosa}%`;
    if (elBarGlosa) elBarGlosa.style.width = `${txGlosa}%`;

    const dashAgenda = document.getElementById('dash-list-agenda');
    const dashAgendaTitulo = document.getElementById('dash-titulo-agenda');
    
    if (dashAgenda) {
        const consultasFiltradas = clinicaState.agenda.agendamentos.filter(a => dataDentroDoFiltro(a.data));
        
        if (dashAgendaTitulo) dashAgendaTitulo.innerHTML = `<i class="fa-solid fa-calendar-check" style="color: var(--primary-light);"></i> Consultas (${nomesFiltros[filtroPeriodo]})`;

        if (consultasFiltradas.length === 0) {
            dashAgenda.innerHTML = '<p style="color: var(--text-light); font-size: 0.9rem; text-align: center; padding: 20px;">Nenhuma consulta neste período.</p>';
        } else {
            consultasFiltradas.sort((a,b) => (a.data + a.hora).localeCompare(b.data + b.hora));

            dashAgenda.innerHTML = consultasFiltradas.map(c => {
                const coresPorStatus = {
                    agendado: 'neutral',
                    confirmado: 'primary',
                    aguardando_atendimento: 'warning',
                    concluido: 'success',
                    cancelado: 'danger'
                };
                let badgeColor = coresPorStatus[c.status] || 'neutral';
                let dataExibicao = (filtroPeriodo === 'hoje' || filtroPeriodo === 'ontem' || filtroPeriodo === 'especifico')
                                 ? c.hora
                                 : `${c.data.split('-').reverse().join('/').slice(0,5)} às ${c.hora}`; 

                return `
                <div class="dash-list-item">
                    <div>
                        <strong style="color: var(--primary-color);">${dataExibicao}</strong> - <strong>${escapeHTML(c.pacNome)}</strong><br>
                        <span style="color: var(--text-light); font-size: 0.75rem;"><i class="fa-solid fa-stethoscope"></i> ${escapeHTML(c.tipo || 'Consulta')}</span>
                    </div>
                    <span class="badge ${badgeColor}" style="font-size:0.7rem; text-transform: uppercase;">${escapeHTML(c.status)}</span>
                </div>
            `}).join('');
        }
    }

    const dashEstoque = document.getElementById('dash-list-estoque');
    if (dashEstoque) {
        const itensAlerta = clinicaState.estoque.filter(i => i.qtd <= i.min);
        if (itensAlerta.length === 0) {
            dashEstoque.innerHTML = '<p style="color: var(--text-light); font-size: 0.9rem; text-align: center; padding: 20px;">Estoque saudável. Nenhum alerta hoje.</p>';
        } else {
            dashEstoque.innerHTML = itensAlerta.map(i => `
                <div class="dash-list-item danger">
                    <div>
                        <strong>${escapeHTML(i.nome)}</strong><br>
                        <span style="color: var(--text-light); font-size: 0.75rem;"><i class="fa-solid fa-barcode"></i> Lote: ${escapeHTML(i.lote)}</span>
                    </div>
                    <div style="text-align: right;">
                        <strong style="color: #dc3545; font-size: 1rem;">${i.qtd} un</strong><br>
                        <span style="font-size: 0.7rem; color: var(--text-light);">Mínimo: ${i.min}</span>
                    </div>
                </div>
            `).join('');
        }
    }

    // Painel "Custos Fixos do Mês" - é uma PREVISÃO (o que está cadastrado
    // em Custos Fixos), não entra na conta de Despesas/Lucro acima, que
    // reflete só o que foi de fato lançado no Livro Caixa.
    const dashCustosFixos = document.getElementById('dash-list-custos-fixos');
    const dashCustosFixosTotal = document.getElementById('dash-custos-fixos-total');
    if (dashCustosFixos) {
        const custos = clinicaState.financeiro.custosFixos.slice().sort((a, b) => a.diaVencimento - b.diaVencimento);

        if (custos.length === 0) {
            dashCustosFixos.innerHTML = '<p style="color: var(--text-light); font-size: 0.9rem; text-align: center; padding: 20px;">Nenhum custo fixo cadastrado.</p>';
        } else {
            dashCustosFixos.innerHTML = custos.map(c => `
                <div class="dash-list-item warning">
                    <div>
                        <strong>${escapeHTML(c.descricao)}</strong><br>
                        <span style="color: var(--text-light); font-size: 0.75rem;"><i class="fa-solid fa-calendar-day"></i> Vence dia ${c.diaVencimento}</span>
                    </div>
                    <strong style="color: var(--text-main); font-size: 0.95rem;">${formatCurrency(c.valor)}</strong>
                </div>
            `).join('');
        }

        if (dashCustosFixosTotal) {
            const totalPrevisto = custos.reduce((soma, c) => soma + c.valor, 0);
            dashCustosFixosTotal.innerHTML = `<span style="color: var(--text-light); font-weight: 600;">Total previsto/mês</span> <span>${formatCurrency(totalPrevisto)}</span>`;
        }
    }

    // Painel "Revisões Pendentes" - pacientes com data de retorno marcada
    // pelo médico na evolução (campo "Retornar em X dias"). Mostra quem já
    // venceu (atrasado) e quem vence nos próximos 7 dias.
    const dashRevisoes = document.getElementById('dash-list-revisoes');
    if (dashRevisoes) {
        const hojeIsoRevisao = getIsoDate(new Date());
        const limiteRevisaoObj = new Date();
        limiteRevisaoObj.setDate(limiteRevisaoObj.getDate() + 7);
        const limiteRevisaoIso = getIsoDate(limiteRevisaoObj);

        const pacientesComRetorno = clinicaState.pacientes
            .filter(p => p.proximoRetorno && p.proximoRetorno <= limiteRevisaoIso)
            .sort((a, b) => a.proximoRetorno.localeCompare(b.proximoRetorno));

        if (pacientesComRetorno.length === 0) {
            dashRevisoes.innerHTML = '<p style="color: var(--text-light); font-size: 0.9rem; text-align: center; padding: 20px;">Nenhuma revisão pendente nos próximos 7 dias.</p>';
        } else {
            dashRevisoes.innerHTML = pacientesComRetorno.map(p => {
                const atrasado = p.proximoRetorno < hojeIsoRevisao;
                const dataExibicao = p.proximoRetorno.split('-').reverse().join('/');
                return `
                <div class="dash-list-item ${atrasado ? 'danger' : 'warning'}">
                    <div>
                        <strong>${escapeHTML(p.nome)}</strong><br>
                        <span style="color: var(--text-light); font-size: 0.75rem;"><i class="fa-solid fa-calendar-day"></i> ${atrasado ? 'Venceu em' : 'Retorno em'} ${dataExibicao}</span>
                    </div>
                    ${atrasado ? '<span class="badge danger bg-danger">Atrasado</span>' : ''}
                </div>`;
            }).join('');
        }
    }

    // ==========================================
    // NOVO: ATUALIZAR O GRÁFICO (Estilo App de Banco)
    // ==========================================
    // Calculado fora do "if (ctx)" porque os gráficos de análise logo
    // abaixo (Receita x Despesa, categorias etc.) também usam essa lista,
    // mesmo que o card do gráfico de saldo diário não esteja na tela.
    const lancamentosFiltrados = clinicaState.financeiro.lancamentos.filter(l => dataDentroDoFiltro(l.competencia));

    const ctx = document.getElementById('dreChart');
    if (ctx) {
        if (dreChartInstance) {
            dreChartInstance.destroy();
        }

        // 1. Agrupar os valores líquidos por data
        const historicoPorData = {};
        
        // Ordena por data (da mais antiga para a mais nova)
        lancamentosFiltrados.sort((a, b) => a.competencia.localeCompare(b.competencia));

        lancamentosFiltrados.forEach(l => {
            if (l.status === 'Recebido/Pago') {
                const dataFormatada = l.competencia.split('-').reverse().join('/'); // Formato DD/MM/AAAA
                if (!historicoPorData[dataFormatada]) historicoPorData[dataFormatada] = 0;
                
                if (l.tipo === 'Receita') historicoPorData[dataFormatada] += l.valor;
                else historicoPorData[dataFormatada] -= l.valor;
            }
        });

        // 2. Separar as chaves (Datas) e os valores (Saldos)
        const labelsData = Object.keys(historicoPorData);
        const valoresSaldo = Object.values(historicoPorData);

        // Prevenção: Se não houver dados, insere um valor zerado para o gráfico não sumir
        if (labelsData.length === 0) {
            labelsData.push('Sem Movimentação');
            valoresSaldo.push(0);
        }

        // 3. Criar o Efeito de Gradiente (Sombreado embaixo da linha)
        const gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 300);
        gradient.addColorStop(0, 'rgba(15, 76, 117, 0.4)'); // Azul primário com 40% de opacidade
        gradient.addColorStop(1, 'rgba(15, 76, 117, 0.0)'); // Fica transparente no fundo

        dreChartInstance = new Chart(ctx, {
            type: 'line', // Muda para Linha
            data: {
                labels: labelsData,
                datasets: [{
                    label: 'Saldo Líquido do Dia (R$)',
                    data: valoresSaldo,
                    borderColor: '#0F4C75', // Cor da linha (Azul Primário do CSS)
                    backgroundColor: gradient, // O sombreado Efeito Banco
                    borderWidth: 3,
                    tension: 0.4, // Isso faz a linha ficar curvada e suave (Efeito Onda)
                    fill: true, // Preenche o espaço debaixo da linha
                    pointBackgroundColor: '#0F4C75',
                    pointRadius: 4, // Tamanho da bolinha ao passar o mouse
                    pointHoverRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        callbacks: {
                            label: function(context) {
                                return ' R$ ' + context.parsed.y.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false } // Remove as linhas verticais para ficar mais clean
                    },
                    y: {
                        grid: { color: '#E2E8F0' }, // Linhas horizontais bem sutis
                        ticks: {
                            callback: function(value) {
                                return 'R$ ' + value.toLocaleString('pt-BR');
                            }
                        }
                    }
                },
                interaction: {
                    mode: 'nearest',
                    axis: 'x',
                    intersect: false
                }
            }
        });
    }

    // ==========================================
    // GRÁFICOS DE ANÁLISE (Receita x Despesa, Despesas por
    // Categoria, Receita por Forma de Pagamento e por Profissional)
    // Reaproveitam o mesmo "lancamentosFiltrados" já calculado
    // acima pro gráfico de saldo diário, respeitando o filtro de
    // período selecionado no topo do Dashboard.
    // ==========================================
    renderizarGraficoReceitaDespesa(lancamentosFiltrados);
    renderizarGraficoDespesaCategoria(lancamentosFiltrados);
    renderizarGraficoReceitaPagamento(lancamentosFiltrados);
    renderizarGraficoReceitaProfissional(lancamentosFiltrados);
}

// Paleta consistente com o resto do sistema (--primary-color, --accent-color etc.)
const CORES_GRAFICO = ['#0F4C75', '#17A673', '#3282B8', '#F4A100', '#BBE1FA', '#DC3545', '#6C757D', '#9C6ADE'];

function renderizarGraficoReceitaDespesa(lancamentosFiltrados) {
    const ctx = document.getElementById('chartReceitaDespesa');
    if (!ctx) return;
    if (chartReceitaDespesaInstance) chartReceitaDespesaInstance.destroy();

    const porData = {};
    lancamentosFiltrados
        .filter(l => l.status === 'Recebido/Pago')
        .sort((a, b) => a.competencia.localeCompare(b.competencia))
        .forEach(l => {
            const dataFormatada = l.competencia.split('-').reverse().join('/');
            if (!porData[dataFormatada]) porData[dataFormatada] = { receita: 0, despesa: 0 };
            if (l.tipo === 'Receita') porData[dataFormatada].receita += l.valor;
            else porData[dataFormatada].despesa += l.valor;
        });

    const labels = Object.keys(porData);
    const receitas = labels.map(d => porData[d].receita);
    const despesas = labels.map(d => porData[d].despesa);

    if (labels.length === 0) labels.push('Sem Movimentação');

    chartReceitaDespesaInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: 'Receita', data: receitas.length ? receitas : [0], backgroundColor: '#17A673', borderRadius: 4 },
                { label: 'Despesa', data: despesas.length ? despesas : [0], backgroundColor: '#DC3545', borderRadius: 4 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' },
                tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${formatCurrency(c.parsed.y)}` } }
            },
            scales: {
                x: { grid: { display: false } },
                y: { grid: { color: '#E2E8F0' }, ticks: { callback: (v) => 'R$ ' + v.toLocaleString('pt-BR') } }
            }
        }
    });
}

function renderizarGraficoDespesaCategoria(lancamentosFiltrados) {
    const ctx = document.getElementById('chartDespesaCategoria');
    if (!ctx) return;
    if (chartDespesaCategoriaInstance) chartDespesaCategoriaInstance.destroy();

    const ROTULOS_TIPO = { 'Custo Fixo': 'Custo Fixo', 'Custo Variavel': 'Custo Variável', 'Repasse': 'Repasse Médico' };
    const porCategoria = {};

    lancamentosFiltrados
        .filter(l => l.status === 'Recebido/Pago' && l.tipo !== 'Receita')
        .forEach(l => {
            const rotulo = ROTULOS_TIPO[l.tipo] || l.tipo;
            porCategoria[rotulo] = (porCategoria[rotulo] || 0) + l.valor;
        });

    const labels = Object.keys(porCategoria);
    const valores = Object.values(porCategoria);

    chartDespesaCategoriaInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels.length ? labels : ['Sem despesas no período'],
            datasets: [{ data: valores.length ? valores : [1], backgroundColor: CORES_GRAFICO, borderWidth: 2, borderColor: '#fff' }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' },
                tooltip: { callbacks: { label: (c) => ` ${c.label}: ${formatCurrency(c.parsed)}` } }
            }
        }
    });
}

function renderizarGraficoReceitaPagamento(lancamentosFiltrados) {
    const ctx = document.getElementById('chartReceitaPagamento');
    if (!ctx) return;
    if (chartReceitaPagamentoInstance) chartReceitaPagamentoInstance.destroy();

    const ROTULOS_PAGAMENTO = { 'Pix': 'Pix', 'Credito': 'Cartão de Crédito', 'Debito': 'Cartão de Débito', 'Boleto': 'Boleto/Transferência', 'Dinheiro': 'Dinheiro', 'Convênio':'Convênio' };
    const porForma = {};

    lancamentosFiltrados
        .filter(l => l.status === 'Recebido/Pago' && l.tipo === 'Receita')
        .forEach(l => {
            const rotulo = ROTULOS_PAGAMENTO[l.pagamento] || l.pagamento;
            porForma[rotulo] = (porForma[rotulo] || 0) + l.valor;
        });

    const labels = Object.keys(porForma);
    const valores = Object.values(porForma);

    chartReceitaPagamentoInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels.length ? labels : ['Sem receitas no período'],
            datasets: [{ data: valores.length ? valores : [1], backgroundColor: CORES_GRAFICO, borderWidth: 2, borderColor: '#fff' }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' },
                tooltip: { callbacks: { label: (c) => ` ${c.label}: ${formatCurrency(c.parsed)}` } }
            }
        }
    });
}

function renderizarGraficoReceitaProfissional(lancamentosFiltrados) {
    const ctx = document.getElementById('chartReceitaProfissional');
    if (!ctx) return;
    if (chartReceitaProfissionalInstance) chartReceitaProfissionalInstance.destroy();

    const porProfissional = {};
    lancamentosFiltrados
        .filter(l => l.status === 'Recebido/Pago' && l.tipo === 'Receita' && l.profissionalNome)
        .forEach(l => {
            porProfissional[l.profissionalNome] = (porProfissional[l.profissionalNome] || 0) + l.valor;
        });

    // Maiores receitas primeiro, fica mais fácil de ler o ranking
    const entradas = Object.entries(porProfissional).sort((a, b) => b[1] - a[1]);
    const labels = entradas.map(e => e[0]);
    const valores = entradas.map(e => e[1]);

    chartReceitaProfissionalInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels.length ? labels : ['Nenhum lançamento vinculado a profissional'],
            datasets: [{ label: 'Receita', data: valores.length ? valores : [0], backgroundColor: '#3282B8', borderRadius: 4 }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => ` ${formatCurrency(c.parsed.x)}` } }
            },
            scales: {
                x: { grid: { color: '#E2E8F0' }, ticks: { callback: (v) => 'R$ ' + v.toLocaleString('pt-BR') } },
                y: { grid: { display: false } }
            }
        }
    });
}

// Filtra os lançamentos pela barra de pesquisa e pelo dropdown de meses
// (usado tanto pela tabela quanto pela exportação em CSV, pra manter os dois sempre consistentes)
function filtrarLancamentos(filtroTexto = '', filtroMes = 'todos') {
    return clinicaState.financeiro.lancamentos.filter(l => {
        const origem = (l.origem || 'manual').toLowerCase();
        const procedimentoNome = (l.procedimentoNome || '').toLowerCase();
        const matchTexto = l.vinculo.toLowerCase().includes(filtroTexto) ||
                           l.tipo.toLowerCase().includes(filtroTexto) ||
                           l.pagamento.toLowerCase().includes(filtroTexto) ||
                           origem.includes(filtroTexto) ||
                           procedimentoNome.includes(filtroTexto);

        let matchMes = true;
        if (filtroMes !== 'todos' && l.competencia) {
            const mesAnoLancamento = l.competencia.substring(0, 7); 
            matchMes = (mesAnoLancamento === filtroMes);
        }

        return matchTexto && matchMes;
    });
}

// ========================================================
// NOVA TABELA FINANCEIRA RESTRUTURADA
// ========================================================
export function atualizarTabelaFinanceiro(filtroTexto = '', filtroMes = 'todos') {
    let totalReceitas = 0;
    let totalDespesas = 0;

    let filtrados = filtrarLancamentos(filtroTexto, filtroMes);

    // TRAVA DE SEGURANÇA: Recepção só enxerga as Entradas no Livro Caixa
    if (clinicaState.sessao.perfil === 'recepcao') {
        filtrados = filtrados.filter(l => l.tipo === 'Receita');
    }

    // Renderiza a Tabela Agrupada
    document.getElementById('finance-table-body').innerHTML = filtrados.slice().reverse().map(l => {
        const isEntrada = l.tipo === 'Receita';

        if (l.status === 'Recebido/Pago') {
            if (isEntrada) totalReceitas += l.valor;
            else totalDespesas += l.valor;
        }

        // Ícones inteligentes baseados na forma de pagamento
        let iconPag = 'fa-money-bill';
        if(l.pagamento === 'Pix') iconPag = 'fa-brands fa-pix';
        else if(l.pagamento.includes('Credito') || l.pagamento.includes('Debito')) iconPag = 'fa-credit-card';
        else if(l.pagamento === 'Boleto') iconPag = 'fa-barcode';
        else if(l.pagamento === 'Convênio') iconPag = 'fa-file-contract';
        
        let corStatus = l.status === 'Recebido/Pago' ? 'success' : (l.status === 'Glosa' || l.status === 'Inadimplente' ? 'danger bg-danger' : 'warning');

        const origemLabel = l.origem === 'agendamento' ? 'Agenda' : (l.origem || 'Manual');
        const nomeProcedimento = l.procedimentoNome ? ` • ${escapeHTML(l.procedimentoNome)}` : '';

        return `<tr>
            <td>
                <span style="font-weight: 600;">${l.competencia.split('-').reverse().join('/')}</span><br>
                <small style="color: var(--text-light);"><i class="fa-solid fa-cash-register"></i> Caixa: ${l.caixa.split('-').reverse().join('/')}</small>
            </td>
            <td>
                <strong>${escapeHTML(l.vinculo)}</strong><br>
                <small style="color: var(--text-light);">${escapeHTML(l.tipo)}${nomeProcedimento}</small><br>
                <small style="color: var(--text-light);"><i class="fa-solid fa-link"></i> Origem: ${escapeHTML(origemLabel)}</small>
            </td>
            <td><i class="fa-solid ${iconPag} icon-primary"></i> ${escapeHTML(l.pagamento)}</td>
            <td><span class="badge ${corStatus}">${escapeHTML(l.status)}</span></td>
            <td class="${isEntrada ? 'positivo' : 'negativo'} valor-lancamento">
                ${isEntrada ? '+' : '-'} ${formatCurrency(l.valor)}
            </td>
            <td>
                ${clinicaState.sessao.perfil === 'recepcao' ? '<span style="color: var(--text-light); font-size: 0.75rem;">—</span>' : `
                <div class="row-actions">
                    <button class="btn-action btn-edit btn-editar-fin" data-id="${l.id}" title="Editar">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="btn-action btn-delete btn-excluir-fin" data-id="${l.id}" title="Excluir">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>`}
            </td>
        </tr>`;
    }).join('');

    // Atualiza o Mini-Dashboard Local (abaixo do título)
    const elRec = document.getElementById('fin-stat-receitas');
    const elDesp = document.getElementById('fin-stat-despesas');
    const elSaldo = document.getElementById('fin-stat-saldo');

    if(elRec) elRec.textContent = formatCurrency(totalReceitas);
    if(elDesp) elDesp.textContent = formatCurrency(totalDespesas);
    if(elSaldo) {
        const saldo = totalReceitas - totalDespesas;
        elSaldo.textContent = formatCurrency(saldo);
        elSaldo.style.color = saldo < 0 ? '#dc3545' : 'var(--primary-color)';
    }
}

// ========================================================
// EXPORTAÇÃO DO RELATÓRIO FINANCEIRO EM EXCEL (respeita o filtro atual da tela)
// Gera um arquivo .xlsx (via ExcelJS) com duas abas:
//   - "Dados": os lançamentos brutos filtrados (só os liquidados), já
//     formatada como tabela (cabeçalho fixo, filtro automático, zebra
//     e cor por tipo de lançamento)
//   - "Resumo": indicadores gerais, receita/despesa por forma de
//     pagamento, despesas por categoria, receita por profissional e
//     evolução mensal - a maioria com fórmulas SUMIFS que leem direto
//     da aba "Dados" (não são valores fixos - se você editar a
//     planilha, os totais recalculam) - além de 4 gráficos de análise
//     embutidos como imagem.
//
// Observação técnica: bibliotecas JS gratuitas para gerar .xlsx no
// navegador (ExcelJS/SheetJS) não conseguem criar um gráfico nativo
// editável do Excel - isso só é possível com Excel de verdade ou libs
// pagas. Por isso os gráficos aqui são inseridos como IMAGEM
// (renderizados com Chart.js), mas os números da planilha continuam
// sendo fórmulas de verdade, editáveis e recalculáveis (exceto Receita
// por Profissional e Evolução Mensal, que são listas dinâmicas de
// tamanho variável e por isso entram como valores já calculados).
// ========================================================

const CATEGORIAS_PAGAMENTO = [
    { chave: 'Pix', label: 'Pix' },
    { chave: 'Credito', label: 'Cartão de Crédito' },
    { chave: 'Debito', label: 'Cartão de Débito' },
    { chave: 'Boleto', label: 'Boleto / Transferência' },
    { chave: 'Dinheiro', label: 'Dinheiro Físico' },
    { chave: 'Convênio', label: 'Convênio' }
];

const CATEGORIAS_DESPESA_TIPO = [
    { chave: 'Custo Fixo', label: 'Custo Fixo' },
    { chave: 'Custo Variavel', label: 'Custo Variável' },
    { chave: 'Repasse', label: 'Repasse Médico' }
];

const CORES_GRAFICO_EXPORT = ['#0F4C75', '#3282B8', '#27AE60', '#F39C12', '#8E44AD', '#E74C3C', '#6C757D', '#BBE1FA'];

// Renderiza um gráfico (pizza, rosca, barra vertical ou horizontal) fora da
// tela (canvas temporário) e devolve a imagem em base64, pronta para ser
// embutida na planilha. Generalizada a partir da antiga
// renderizarGraficoPizzaBase64 para reaproveitar em todos os gráficos
// analíticos da exportação (antes só existia o de pizza da receita).
function renderizarGraficoExportBase64({ type, labels, datasets, titulo, indexAxis, largura = 480, altura = 320 }) {
    return new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        canvas.width = largura;
        canvas.height = altura;
        canvas.style.position = 'absolute';
        canvas.style.left = '-9999px';
        document.body.appendChild(canvas);

        const chart = new Chart(canvas, {
            type,
            data: { labels, datasets },
            options: {
                responsive: false,
                animation: false,
                indexAxis: indexAxis || 'x',
                plugins: {
                    title: { display: true, text: titulo, font: { size: 14 } },
                    legend: { position: 'bottom', labels: { font: { size: 10 } } }
                },
                scales: type === 'bar'
                    ? (indexAxis === 'y'
                        ? { x: { ticks: { callback: (v) => 'R$ ' + Number(v).toLocaleString('pt-BR') } } }
                        : { y: { ticks: { callback: (v) => 'R$ ' + Number(v).toLocaleString('pt-BR') } } })
                    : undefined
            }
        });

        // animation:false já desenha de forma síncrona, mas aguardamos
        // um frame por segurança antes de capturar a imagem do canvas
        requestAnimationFrame(() => {
            const dataUrl = canvas.toDataURL('image/png');
            chart.destroy();
            document.body.removeChild(canvas);
            resolve(dataUrl);
        });
    });
}

export async function exportarFinanceiroExcel() {
    // Relatório completo (com gráficos e agregações) é restrito ao
    // Administrador - a recepção só lança, não analisa.
    if (clinicaState.sessao.perfil === 'recepcao') {
        showToast('Exportação de relatórios é restrita ao Administrador.', 'error');
        return;
    }

    const searchFin = document.getElementById('search-financeiro');
    const mesFin = document.getElementById('filtro-mes-financeiro');
    const filtroTexto = searchFin ? searchFin.value.toLowerCase() : '';
    const filtroMes = mesFin ? mesFin.value : 'todos';

    // Só entram no relatório os lançamentos já liquidados - é a mesma regra
    // que a DRE do dashboard usa pra contar Receitas/Despesas (ver calcularDRE)
    const lancamentos = filtrarLancamentos(filtroTexto, filtroMes)
        .filter(l => l.status === 'Recebido/Pago')
        .slice()
        .sort((a, b) => a.competencia.localeCompare(b.competencia));

    if (lancamentos.length === 0) {
        showToast('Nenhum lançamento liquidado para exportar com o filtro atual.', 'warning');
        return;
    }

    const btnExportar = document.getElementById('btn-exportar-financeiro');

    await comEstadoDeCarregamento(btnExportar, 'Gerando Excel...', async () => {
        try {
            // ===== Agregações em JS usadas para desenhar os gráficos e as
            // seções dinâmicas do Resumo (Receita por Profissional e
            // Evolução Mensal). As demais seções da planilha usam fórmulas
            // SUMIFS de verdade, então não dependem destes valores. =====
            const receitaPorPagamento = {};
            CATEGORIAS_PAGAMENTO.forEach(c => { receitaPorPagamento[c.chave] = 0; });

            const despesaPorCategoria = {};
            CATEGORIAS_DESPESA_TIPO.forEach(c => { despesaPorCategoria[c.chave] = 0; });

            const porData = {};             // Receita x Despesa por competência (gráfico 3)
            const receitaPorProfissional = {};
            const porMes = {};              // Evolução mensal (Receita/Despesa)

            lancamentos.forEach(l => {
                if (l.tipo === 'Receita' && receitaPorPagamento[l.pagamento] !== undefined) {
                    receitaPorPagamento[l.pagamento] += l.valor;
                }
                if (l.tipo !== 'Receita' && despesaPorCategoria[l.tipo] !== undefined) {
                    despesaPorCategoria[l.tipo] += l.valor;
                }

                const dataFormatada = l.competencia.split('-').reverse().join('/');
                if (!porData[dataFormatada]) porData[dataFormatada] = { receita: 0, despesa: 0 };
                if (l.tipo === 'Receita') porData[dataFormatada].receita += l.valor;
                else porData[dataFormatada].despesa += l.valor;

                if (l.tipo === 'Receita' && l.profissionalNome) {
                    receitaPorProfissional[l.profissionalNome] = (receitaPorProfissional[l.profissionalNome] || 0) + l.valor;
                }

                const mesRef = l.competencia.substring(0, 7);
                if (!porMes[mesRef]) porMes[mesRef] = { receita: 0, despesa: 0 };
                if (l.tipo === 'Receita') porMes[mesRef].receita += l.valor;
                else porMes[mesRef].despesa += l.valor;
            });

            // --- Gráfico 1: Receita por Forma de Pagamento (rosca) ---
            const catComReceita = CATEGORIAS_PAGAMENTO.filter(c => receitaPorPagamento[c.chave] > 0);
            const imgReceitaPagamento = catComReceita.length > 0
                ? await renderizarGraficoExportBase64({
                    type: 'doughnut',
                    labels: catComReceita.map(c => c.label),
                    datasets: [{ data: catComReceita.map(c => receitaPorPagamento[c.chave]), backgroundColor: CORES_GRAFICO_EXPORT }],
                    titulo: 'Receitas por Forma de Pagamento'
                })
                : null;

            // --- Gráfico 2: Despesas por Categoria (rosca) ---
            const catComDespesa = CATEGORIAS_DESPESA_TIPO.filter(c => despesaPorCategoria[c.chave] > 0);
            const imgDespesaCategoria = catComDespesa.length > 0
                ? await renderizarGraficoExportBase64({
                    type: 'doughnut',
                    labels: catComDespesa.map(c => c.label),
                    datasets: [{ data: catComDespesa.map(c => despesaPorCategoria[c.chave]), backgroundColor: CORES_GRAFICO_EXPORT }],
                    titulo: 'Despesas por Categoria'
                })
                : null;

            // --- Gráfico 3: Receita x Despesa por Competência (barras agrupadas) ---
            const labelsData = Object.keys(porData);
            const imgReceitaDespesa = await renderizarGraficoExportBase64({
                type: 'bar',
                labels: labelsData,
                datasets: [
                    { label: 'Receita', data: labelsData.map(d => porData[d].receita), backgroundColor: '#17A673' },
                    { label: 'Despesa', data: labelsData.map(d => porData[d].despesa), backgroundColor: '#DC3545' }
                ],
                titulo: 'Receita x Despesa por Competência'
            });

            // --- Gráfico 4: Receita por Profissional (barra horizontal, ranking) ---
            const rankingProfissional = Object.entries(receitaPorProfissional).sort((a, b) => b[1] - a[1]);
            const imgReceitaProfissional = rankingProfissional.length > 0
                ? await renderizarGraficoExportBase64({
                    type: 'bar',
                    labels: rankingProfissional.map(e => e[0]),
                    datasets: [{ label: 'Receita', data: rankingProfissional.map(e => e[1]), backgroundColor: '#3282B8' }],
                    titulo: 'Receita por Profissional',
                    indexAxis: 'y'
                })
                : null;

            const workbook = new ExcelJS.Workbook();
            workbook.creator = 'GestãoPRO';
            workbook.created = new Date();

            // ================= ABA "Dados" (base para as fórmulas do Resumo) =================
            const abaDados = workbook.addWorksheet('Dados', {
                views: [{ state: 'frozen', ySplit: 1 }] // cabeçalho fixo ao rolar a tabela
            });
            abaDados.columns = [
                { header: 'Competência', key: 'competencia', width: 14 },
                { header: 'Data de Caixa', key: 'caixa', width: 14 },
                { header: 'Tipo', key: 'tipo', width: 16 },
                { header: 'Vínculo', key: 'vinculo', width: 28 },
                { header: 'Forma de Pagamento', key: 'pagamento', width: 20 },
                { header: 'Status', key: 'status', width: 16 },
                { header: 'Valor', key: 'valor', width: 14 },
                { header: 'Profissional', key: 'profissional', width: 24 }
            ];
            abaDados.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
            abaDados.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F4C75' } };
            abaDados.getRow(1).alignment = { vertical: 'middle' };

            const bordaFina = { style: 'thin', color: { argb: 'FFE2E8F0' } };

            lancamentos.forEach((l, indice) => {
                const linhaAdicionada = abaDados.addRow({
                    competencia: l.competencia.split('-').reverse().join('/'),
                    caixa: l.caixa.split('-').reverse().join('/'),
                    tipo: l.tipo,
                    vinculo: l.vinculo,
                    pagamento: l.pagamento,
                    status: l.status,
                    valor: l.valor,
                    profissional: l.profissionalNome || ''
                });

                // Zebra striping (linhas pares levemente sombreadas, mais fácil de ler)
                if (indice % 2 === 1) {
                    linhaAdicionada.eachCell({ includeEmpty: true }, (cel) => {
                        cel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F7FA' } };
                    });
                }
                // Destaque de cor no valor: verde para receita, vermelho para despesa
                linhaAdicionada.getCell('valor').font = { color: { argb: l.tipo === 'Receita' ? 'FF17A673' : 'FFDC3545' }, bold: true };
                linhaAdicionada.eachCell({ includeEmpty: true }, (cel) => { cel.border = { bottom: bordaFina }; });
            });
            abaDados.getColumn('valor').numFmt = '"R$" #,##0.00';
            const ultimaLinhaDados = abaDados.rowCount;
            abaDados.autoFilter = { from: 'A1', to: `H${ultimaLinhaDados}` };

            // ================= ABA "Resumo" =================
            const abaResumo = workbook.addWorksheet('Resumo', { views: [{ showGridLines: false }] });
            abaResumo.getColumn(1).width = 26;
            abaResumo.getColumn(2).width = 16;
            abaResumo.getColumn(3).width = 16;
            abaResumo.getColumn(4).width = 16;
            abaResumo.getColumn(5).width = 4;

            abaResumo.mergeCells('A1:B1');
            abaResumo.getCell('A1').value = 'Relatório Financeiro — GestãoPRO';
            abaResumo.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF0F4C75' } };

            abaResumo.getCell('A2').value = `Período: ${filtroMes === 'todos' ? 'Todos os meses' : filtroMes} | Gerado em ${new Date().toLocaleString('pt-BR')}`;
            abaResumo.getCell('A2').font = { italic: true, size: 9, color: { argb: 'FF6C757D' } };

            let linha = 4;

            const escreverTituloSecao = (texto) => {
                abaResumo.mergeCells(`A${linha}:B${linha}`);
                const cel = abaResumo.getCell(`A${linha}`);
                cel.value = texto;
                cel.font = { bold: true, color: { argb: 'FFFFFFFF' } };
                cel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F4C75' } };
                linha++;
            };

            // ehFormula=false permite escrever um valor já calculado em vez de
            // fórmula - usado nas seções cuja lista de linhas é dinâmica
            // (Receita por Profissional) e por isso não dá pra fixar em SUMIFS
            const escreverLinhaCategoria = (label, formulaOuValor, ehFormula = true) => {
                abaResumo.getCell(`A${linha}`).value = label;
                const celValor = abaResumo.getCell(`B${linha}`);
                celValor.value = ehFormula ? { formula: formulaOuValor } : formulaOuValor;
                celValor.numFmt = '"R$" #,##0.00';
                linha++;
            };

            const escreverLinhaTotal = (label, formula) => {
                const celLabel = abaResumo.getCell(`A${linha}`);
                celLabel.value = label;
                celLabel.font = { bold: true };
                celLabel.border = { top: { style: 'thin' } };
                const celValor = abaResumo.getCell(`B${linha}`);
                celValor.value = { formula };
                celValor.numFmt = '"R$" #,##0.00';
                celValor.font = { bold: true };
                celValor.border = { top: { style: 'thin' } };
                linha++;
            };

            // --- Indicadores Gerais ---
            escreverTituloSecao('INDICADORES GERAIS');
            const totalReceitasCalc = lancamentos.filter(l => l.tipo === 'Receita').reduce((s, l) => s + l.valor, 0);
            const qtdReceitas = lancamentos.filter(l => l.tipo === 'Receita').length;
            const ticketMedio = qtdReceitas > 0 ? totalReceitasCalc / qtdReceitas : 0;

            abaResumo.getCell(`A${linha}`).value = 'Total de Lançamentos';
            abaResumo.getCell(`B${linha}`).value = lancamentos.length;
            linha++;
            escreverLinhaCategoria('Ticket Médio (Receita)', ticketMedio, false);

            linha++; // linha em branco

            // --- Receita dividida por forma de pagamento ---
            escreverTituloSecao('RECEITAS POR FORMA DE PAGAMENTO');
            const inicioReceita = linha;
            CATEGORIAS_PAGAMENTO.forEach(c => {
                escreverLinhaCategoria(c.label, `SUMIFS(Dados!$G$2:$G$${ultimaLinhaDados},Dados!$C$2:$C$${ultimaLinhaDados},"Receita",Dados!$E$2:$E$${ultimaLinhaDados},"${c.chave}")`);
            });
            const fimReceita = linha - 1;
            escreverLinhaTotal('TOTAL RECEITAS', `SUM(B${inicioReceita}:B${fimReceita})`);
            const linhaTotalReceita = linha - 1;

            linha++; // linha em branco

            // --- Despesas (Custo Fixo + Custo Variável + Repasse) por forma de pagamento ---
            escreverTituloSecao('DESPESAS POR FORMA DE PAGAMENTO');
            const inicioDespesa = linha;
            CATEGORIAS_PAGAMENTO.forEach(c => {
                escreverLinhaCategoria(c.label, `SUMIFS(Dados!$G$2:$G$${ultimaLinhaDados},Dados!$C$2:$C$${ultimaLinhaDados},"<>Receita",Dados!$E$2:$E$${ultimaLinhaDados},"${c.chave}")`);
            });
            const fimDespesa = linha - 1;
            escreverLinhaTotal('TOTAL DESPESAS', `SUM(B${inicioDespesa}:B${fimDespesa})`);
            const linhaTotalDespesa = linha - 1;

            linha++; // linha em branco

            // --- Despesas por Categoria (Custo Fixo / Custo Variável / Repasse) ---
            escreverTituloSecao('DESPESAS POR CATEGORIA');
            const inicioDespCat = linha;
            CATEGORIAS_DESPESA_TIPO.forEach(c => {
                escreverLinhaCategoria(c.label, `SUMIFS(Dados!$G$2:$G$${ultimaLinhaDados},Dados!$C$2:$C$${ultimaLinhaDados},"${c.chave}")`);
            });
            const fimDespCat = linha - 1;
            escreverLinhaTotal('TOTAL DESPESAS (CATEGORIA)', `SUM(B${inicioDespCat}:B${fimDespCat})`);

            linha++; // linha em branco

            // --- Lucro líquido (Total Receitas - Total Despesas) ---
            const celLucroLabel = abaResumo.getCell(`A${linha}`);
            celLucroLabel.value = 'LUCRO LÍQUIDO';
            celLucroLabel.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
            celLucroLabel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF27AE60' } };

            const celLucroValor = abaResumo.getCell(`B${linha}`);
            celLucroValor.value = { formula: `B${linhaTotalReceita}-B${linhaTotalDespesa}` };
            celLucroValor.numFmt = '"R$" #,##0.00';
            celLucroValor.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
            celLucroValor.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF27AE60' } };

            linha += 2; // respiro antes das seções dinâmicas

            // --- Receita por Profissional (lista dinâmica de nomes - valores
            // já calculados, não é possível fixar uma fórmula SUMIFS porque a
            // quantidade e os nomes dos profissionais variam por clínica) ---
            if (rankingProfissional.length > 0) {
                escreverTituloSecao('RECEITA POR PROFISSIONAL');
                rankingProfissional.forEach(([nome, valor]) => {
                    escreverLinhaCategoria(nome, valor, false);
                });
                linha++; // linha em branco
            }

            // --- Evolução Mensal (Receita, Despesa, Saldo) - tabela de 4
            // colunas, também com valores já calculados pelo mesmo motivo ---
            const mesesOrdenados = Object.keys(porMes).sort();
            if (mesesOrdenados.length > 0) {
                abaResumo.mergeCells(`A${linha}:D${linha}`);
                const celTituloMensal = abaResumo.getCell(`A${linha}`);
                celTituloMensal.value = 'EVOLUÇÃO MENSAL';
                celTituloMensal.font = { bold: true, color: { argb: 'FFFFFFFF' } };
                celTituloMensal.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F4C75' } };
                linha++;

                ['Mês', 'Receita', 'Despesa', 'Saldo'].forEach((titulo, i) => {
                    const cel = abaResumo.getCell(linha, i + 1);
                    cel.value = titulo;
                    cel.font = { bold: true };
                    cel.border = { bottom: { style: 'thin' } };
                });
                linha++;

                mesesOrdenados.forEach(mes => {
                    const [ano, mesNum] = mes.split('-');
                    const receitaMes = porMes[mes].receita;
                    const despesaMes = porMes[mes].despesa;

                    abaResumo.getCell(`A${linha}`).value = `${mesNum}/${ano}`;

                    const cReceita = abaResumo.getCell(`B${linha}`);
                    cReceita.value = receitaMes;
                    cReceita.numFmt = '"R$" #,##0.00';

                    const cDespesa = abaResumo.getCell(`C${linha}`);
                    cDespesa.value = despesaMes;
                    cDespesa.numFmt = '"R$" #,##0.00';

                    const saldoMes = receitaMes - despesaMes;
                    const cSaldo = abaResumo.getCell(`D${linha}`);
                    cSaldo.value = saldoMes;
                    cSaldo.numFmt = '"R$" #,##0.00';
                    cSaldo.font = { bold: true, color: { argb: saldoMes < 0 ? 'FFDC3545' : 'FF17A673' } };

                    linha++;
                });
            }

            // --- Gráficos de análise (imagem - ver observação técnica no topo
            // da função), dispostos em grade 2x2 à direita das tabelas ---
            [
                { img: imgReceitaPagamento, col: 5, row: 3 },
                { img: imgDespesaCategoria, col: 5, row: 24 },
                { img: imgReceitaDespesa, col: 13, row: 3 },
                { img: imgReceitaProfissional, col: 13, row: 24 }
            ].forEach(({ img, col, row }) => {
                if (!img) return;
                const imageId = workbook.addImage({ base64: img, extension: 'png' });
                abaResumo.addImage(imageId, { tl: { col, row }, ext: { width: 440, height: 290 } });
            });

            // ================= GERA E BAIXA O ARQUIVO =================
            const buffer = await workbook.xlsx.writeBuffer();
            const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const dataAtual = new Date().toISOString().split('T')[0];

            link.href = url;
            link.download = `relatorio-financeiro_${dataAtual}.xlsx`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);

            showToast(`Relatório Excel gerado com ${lancamentos.length} lançamento(s).`, 'success');
        } catch (error) {
            console.error("Erro ao gerar relatório Excel: ", error);
            showToast('Falha ao gerar o relatório Excel.', 'error');
        }
    });
}

export async function carregarFinanceiro() {
    try {
        const q = query(
            collection(db, "financeiro"), 
            where("clinicaId", "==", clinicaState.sessao.clinicaId)
        );
        const querySnapshot = await getDocs(q);
        
        clinicaState.financeiro.lancamentos = [];
                  
        querySnapshot.forEach((doc) => {
            clinicaState.financeiro.lancamentos.push({
                ...doc.data(),
                id: String(doc.id)
            });
        });

        // Alimenta automaticamente o seletor de meses com as datas que existem no banco!
        const mesSelect = document.getElementById('filtro-mes-financeiro');
        if (mesSelect) {
            const mesesUnicos = [...new Set(clinicaState.financeiro.lancamentos.map(l => l.competencia.substring(0, 7)))].sort().reverse();
            const valorAtual = mesSelect.value; 
            
            mesSelect.innerHTML = '<option value="todos">Todos os Meses</option>' +
                mesesUnicos.map(m => {
                    const [ano, mes] = m.split('-');
                    return `<option value="${m}">${mes}/${ano}</option>`;
                }).join('');
                
            // Mantém o filtro aplicado, se ainda existir na lista nova
            if ([...mesSelect.options].some(o => o.value === valorAtual)) {
                mesSelect.value = valorAtual;
            }
        }
        
        // Renderiza tudo e atualiza os dashboards
        const barraPesquisa = document.getElementById('search-financeiro');
        const searchTexto = barraPesquisa ? barraPesquisa.value.toLowerCase() : '';
        
        atualizarTabelaFinanceiro(searchTexto, mesSelect ? mesSelect.value : 'todos');
        calcularDRE(); 
             
    } catch (error) {
        console.error("Erro ao buscar dados financeiros: ", error);
        showToast('Erro ao carregar o livro caixa.', 'error');
    }
}