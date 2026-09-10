import { clinicaState } from './state.js';
import { showToast, escapeHTML, confirmarAcao } from './Ferramentas.js';
import { db } from './firebase.js';
import { collection, addDoc, doc, updateDoc, deleteDoc, query, where, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { abrirModalPagamento } from './agenda.js';
import { abrirProntuario } from './pacientes.js';

const ICONES_TIPO = {
    retorno_pendente: 'fa-calendar-check',
    exame_solicitado: 'fa-flask-vial',
    encaminhamento: 'fa-share-from-square',
    estoque: 'fa-boxes-stacked',
    financeiro: 'fa-cash-register',
    pagamento_pendente: 'fa-hand-holding-dollar',
    geral: 'fa-bell'
};

// ========================================================
// RESOLVER "CONFIRMAR PAGAMENTO" DE VERDADE
// Antes, resolver essa notificação só marcava o AVISO como
// concluído - o agendamento continuava sem pagamento registrado e
// nada entrava no Livro Caixa. Agora a notificação carrega o
// agendamentoId (ver criarNotificacao em agenda.js) e resolver ela
// leva a pessoa pra Agenda e abre o mesmo modal de pagamento usado
// ali - é ele quem marca o agendamento como pago, lança a receita
// no Financeiro E encerra esta notificação, tudo de uma vez (ver
// abrirModalPagamento em agenda.js).
// ========================================================
async function tratarNotificacaoPagamento(n) {
    if (n.agendamentoId) {
        const btnAgenda = document.querySelector('.menu-btn[data-target="agenda"]');
        if (btnAgenda) btnAgenda.click();
        await abrirModalPagamento(n.agendamentoId, n.id);
        return;
    }

    // Notificação antiga (criada antes desta correção), sem vínculo com
    // o agendamento - não dá pra abrir o pagamento de verdade, então só
    // permite dispensar o aviso manualmente.
    const confirmou = await confirmarAcao(
        `${n.mensagem} O pagamento foi realizado? (Notificação antiga, sem vínculo direto com o agendamento - confirme o lançamento manualmente no Livro Caixa se ainda não tiver feito isso.)`,
        { titulo: n.titulo || 'Confirmar pagamento', textoConfirmar: 'Marcar como resolvida', perigoso: false }
    );
    if (!confirmou) return;

    try {
        await updateDoc(doc(db, "notificacoes", n.id), {
            status: 'concluida',
            resolvidoPor: clinicaState.sessao.nome,
            resolvidoEm: new Date().toISOString()
        });
        showToast('Notificação marcada como resolvida.', 'success');
    } catch (error) {
        console.error("Erro ao confirmar pagamento: ", error);
        showToast('Falha ao atualizar. Tente novamente.', 'error');
    }
}

// ========================================================
// DIRECIONAMENTO POR TIPO
// Clicar em "Resolver" leva a pessoa direto pra onde a pendência
// precisa ser tratada, em vez de só sumir a notificação sem contexto.
// ========================================================
function navegarParaContexto(n) {
    const irPara = (target) => {
        const btn = document.querySelector(`.menu-btn[data-target="${target}"]`);
        if (btn) btn.click();
    };

    if (n.tipo === 'exame_solicitado' || n.tipo === 'encaminhamento' || n.tipo === 'retorno_pendente') {
        irPara('agenda'); 
        setTimeout(() => {
            // Clica automaticamente no botão de agendar para facilitar para a recepção
            document.getElementById('btn-novo-agendamento')?.click();
            
            setTimeout(() => {
                const selPac = document.getElementById('agenda-paciente');
                if (selPac && n.pacienteId) selPac.value = n.pacienteId;
                showToast(`Selecione o horário para ${n.pacienteNome}.`, 'info');
            }, 100);
        }, 50);
        return;
    }

    if (n.tipo === 'estoque') { irPara('estoque'); return; }
    if (n.tipo === 'financeiro') { irPara('financeiro'); return; }
}

// ========================================================
// DISPENSAR ALERTA LOCAL
// Os alertas locais (estoque, consultas de hoje/amanhã) são
// recalculados a cada atualização, não vêm do banco - "apagar"
// aqui significa esconder aquele aviso específico enquanto a
// sessão estiver aberta. Se a mesma condição ainda existir na
// próxima vez que a página carregar do zero, o aviso volta -
// isso é intencional (ex: item continua vencido).
// ========================================================
const alertasLocaisDispensados = new Set();

// ========================================================
// GERADOR DE ALERTAS LOCAIS (Economiza o Firebase)
// ========================================================
function gerarAlertasLocais() {
    const alertas = [];
    const hojeData = new Date();
    
    clinicaState.estoque.forEach(item => {
        if (item.qtd <= item.min) {
            alertas.push({ id: `local-estoque-baixo-${item.id}`, tipo: 'estoque', titulo: 'Estoque Baixo', mensagem: `${item.nome} atingiu o mínimo!`, criadoPor: 'Sistema', status: 'pendente', local: true });
        }
        const diasVenc = Math.floor((new Date(item.validade) - hojeData) / (1000 * 60 * 60 * 24));
        if (diasVenc <= 30 && diasVenc >= 0) {
            alertas.push({ id: `local-estoque-venc-${item.id}`, tipo: 'estoque', titulo: 'Vencimento Próximo', mensagem: `Lote ${item.lote} de ${item.nome} vence em ${diasVenc} dias!`, criadoPor: 'Sistema', status: 'pendente', local: true });
        } else if (diasVenc < 0) {
            alertas.push({ id: `local-estoque-vencido-${item.id}`, tipo: 'estoque', titulo: 'Item Vencido', mensagem: `Lote ${item.lote} de ${item.nome} está vencido!`, criadoPor: 'Sistema', status: 'pendente', local: true });
        }
    });

    const getIsoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const hojeIso = getIsoDate(hojeData);
    const amanhaObj = new Date();
    amanhaObj.setDate(amanhaObj.getDate() + 1);
    const amanhaIso = getIsoDate(amanhaObj);

    const consultasHoje = clinicaState.agenda.agendamentos.filter(a => a.data === hojeIso && a.status !== 'cancelado');
    const consultasAmanha = clinicaState.agenda.agendamentos.filter(a => a.data === amanhaIso && a.status !== 'cancelado');

    if (consultasHoje.length > 0) alertas.push({ id: `local-consultas-${hojeIso}`, tipo: 'geral', titulo: 'Consultas Hoje', mensagem: `Você tem ${consultasHoje.length} consulta(s) para hoje.`, criadoPor: 'Sistema', status: 'pendente', local: true });
    if (consultasAmanha.length > 0) alertas.push({ id: `local-consultas-${amanhaIso}`, tipo: 'geral', titulo: 'Consultas Amanhã', mensagem: `Você tem ${consultasAmanha.length} consulta(s) para amanhã.`, criadoPor: 'Sistema', status: 'pendente', local: true });
    
    return alertas.filter(a => !alertasLocaisDispensados.has(a.id));
}

// ========================================================
// RESOLUÇÃO DE PENDÊNCIA
// "Resolver" não é mais um clique único que já apaga a notificação:
// primeiro leva a pessoa pro contexto certo, e só marca como concluída
// depois de uma confirmação explícita de que a ação foi realizada.
// Pagamento tem fluxo próprio (popup dedicado, ver tratarNotificacaoPagamento).
// ========================================================
async function tratarResolverNotificacao(n, btnResolver) {
    if (n.tipo === 'pagamento_pendente') {
        await tratarNotificacaoPagamento(n);
        return;
    }

    navegarParaContexto(n);

    const confirmou = await confirmarAcao(
        'Você já concluiu esta pendência? A notificação só sai da lista se confirmar aqui - clicar em "Resolver" sozinho não é suficiente.',
        { titulo: 'Confirmar resolução', textoConfirmar: 'Sim, já resolvi', perigoso: false }
    );
    if (!confirmou) return;

    if (btnResolver) btnResolver.disabled = true;
    try {
        await updateDoc(doc(db, "notificacoes", n.id), {
            status: 'concluida',
            resolvidoPor: clinicaState.sessao.nome,
            resolvidoEm: new Date().toISOString()
        });
        showToast('Pendência marcada como resolvida.', 'success');
    } catch (error) {
        console.error("Erro ao resolver notificação: ", error);
        showToast('Falha ao atualizar pendência.', 'error');
        if (btnResolver) btnResolver.disabled = false;
    }
}

// ========================================================
// APAGAR NOTIFICAÇÃO
// Alerta local: só sai da lista nesta sessão (ver
// alertasLocaisDispensados acima). Notificação do banco: exclui
// de fato o documento - funciona tanto pendente quanto resolvida,
// pra permitir limpar o histórico da Central de Notificações.
// ========================================================
async function apagarNotificacao(n) {
    const confirmou = await confirmarAcao(
        'Deseja apagar esta notificação? Essa ação não pode ser desfeita.',
        { titulo: 'Apagar notificação', textoConfirmar: 'Apagar' }
    );
    if (!confirmou) return;

    if (n.local) {
        alertasLocaisDispensados.add(n.id);
        atualizarBadgeNotificacoes();
        atualizarListaNotificacoes(document.getElementById('filtro-notificacoes')?.value || 'pendentes');
        return;
    }

    try {
        await deleteDoc(doc(db, "notificacoes", n.id));
        showToast('Notificação apagada.', 'success');
    } catch (error) {
        console.error("Erro ao apagar notificação: ", error);
        showToast('Falha ao apagar a notificação.', 'error');
    }
}

export function initNotificacoes() {
    const lista = document.getElementById('notificacoes-lista');
    if (lista) {
        lista.addEventListener('click', async (e) => {
            const btnResolver = e.target.closest('.btn-resolver-notificacao');
            const btnApagar = e.target.closest('.btn-apagar-notificacao');
            if (!btnResolver && !btnApagar) return;

            const id = (btnResolver || btnApagar).getAttribute('data-id');
            const n = clinicaState.notificacoes.find(x => String(x.id) === String(id))
                || gerarAlertasLocais().find(x => String(x.id) === String(id));
            if (!n) return;

            if (btnApagar) {
                await apagarNotificacao(n);
                return;
            }

            await tratarResolverNotificacao(n, btnResolver);
        });
    }

    const filtro = document.getElementById('filtro-notificacoes');
    if (filtro) {
        filtro.addEventListener('change', () => atualizarListaNotificacoes(filtro.value));
    }
}

// Usado por outros módulos (ex: pacientes.js, agenda.js) para abrir uma
// pendência. Não precisa recarregar nada na tela: quem está com a aba de
// Notificações aberta em QUALQUER sessão recebe isso na hora via
// escutarNotificacoes(). Retorna a referência do documento criado - a
// Agenda usa isso pra linkar a notificação de "pagamento pendente" ao
// agendamento de verdade (ver agendamentoId e abrirModalPagamento).
export async function criarNotificacao({ tipo = 'geral', titulo, mensagem, pacienteId = null, pacienteNome = null, agendamentoId = null }) {
    try {
        return await addDoc(collection(db, "notificacoes"), {
            tipo,
            titulo,
            mensagem,
            pacienteId,
            pacienteNome,
            agendamentoId,
            status: 'pendente',
            criadoPor: clinicaState.sessao.nome,
            criadoEm: new Date().toISOString(),
            clinicaId: clinicaState.sessao.clinicaId
        });
    } catch (error) {
        console.error("Erro ao criar notificação: ", error);
        return null;
    }
}

// Escuta em tempo real (Firestore onSnapshot): assim que alguém cria uma
// pendência, qualquer outra sessão logada na mesma clínica vê na hora,
// sem precisar dar F5. É isso que faz o aviso "chegar" pra recepção
// no exato momento em que o médico grava o retorno.
let pararDeEscutar = null;
let primeiraCarga = true;

export function escutarNotificacoes() {
    const q = query(
        collection(db, "notificacoes"),
        where("clinicaId", "==", clinicaState.sessao.clinicaId)
    );

    pararDeEscutar = onSnapshot(q, (snapshot) => {
        clinicaState.notificacoes = [];
        snapshot.forEach((d) => {
            clinicaState.notificacoes.push({ ...d.data(), id: String(d.id) });
        });

        // Toast em tempo real só pra pendências novas chegando depois do
        // login (a primeira carga não deve gerar uma enxurrada de toasts)
        if (!primeiraCarga) {
            snapshot.docChanges().forEach((change) => {
                if (change.type === 'added' && change.doc.data().status === 'pendente') {
                    const n = { ...change.doc.data(), id: String(change.doc.id) };

                    // Nenhum tipo de notificação interrompe a tela com popup
                    // automático - toda pendência (inclusive pagamento) só
                    // avisa por toast e fica esperando na Central de
                    // Notificações até alguém clicar em "Resolver".
                    showToast(`Nova pendência: ${n.titulo}`, 'warning');
                }
            });
        }
        primeiraCarga = false;

        atualizarBadgeNotificacoes();
        atualizarListaNotificacoes(document.getElementById('filtro-notificacoes')?.value || 'pendentes');
    }, (error) => {
        console.error("Erro ao escutar notificações: ", error);
    });
}

export function pararEscutaNotificacoes() {
    if (pararDeEscutar) pararDeEscutar();
}

function atualizarBadgeNotificacoes() {
    const badge = document.getElementById('badge-notificacoes');
    if (!badge) return;

    let pendentes = clinicaState.notificacoes.filter(n => n.status === 'pendente').length;
    pendentes += gerarAlertasLocais().length; // Soma os alertas grátis na bolinha vermelha

    badge.textContent = pendentes;
    badge.style.display = pendentes > 0 ? 'inline-flex' : 'none';
}

export function atualizarListaNotificacoes(filtro = 'pendentes') {
    const lista = document.getElementById('notificacoes-lista');
    if (!lista) return;

    let itens = clinicaState.notificacoes.slice();
    
    // Mistura as notificações do banco com as grátis do sistema
    if (filtro === 'pendentes' || filtro === 'todas') {
        itens = itens.concat(gerarAlertasLocais());
    }

    if (filtro === 'pendentes') itens = itens.filter(n => n.status === 'pendente');
    else if (filtro === 'concluidas') itens = itens.filter(n => n.status === 'concluida');

    itens.sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));

    if (itens.length === 0) {
        lista.innerHTML = '<p style="color: var(--text-light); text-align: center; padding: 30px;">Nenhuma pendência por aqui. Tudo em dia! ✅</p>';
        return;
    }

    lista.innerHTML = itens.map(n => {
        const icone = ICONES_TIPO[n.tipo] || ICONES_TIPO.geral;
        const dataFormatada = n.criadoEm ? new Date(n.criadoEm).toLocaleString('pt-BR') : 'Agora';
        const concluida = n.status === 'concluida';

        // Alerta local ganha um selo informativo em vez de botão de
        // resolver (não tem "onde resolver" - some sozinho quando a
        // condição deixar de existir). Apagar continua disponível pra
        // quem quiser tirar da lista antes disso.
        const acaoPrincipal = n.local
            ? `<span class="badge info" title="Aviso Automático"><i class="fa-solid fa-robot"></i> Alerta de Sistema</span>`
            : (concluida
                ? `<span class="badge success" title="${n.resolvidoAutomaticamente ? 'Resolvida automaticamente' : 'Resolvida por ' + escapeHTML(n.resolvidoPor || '')}">${n.resolvidoAutomaticamente ? '<i class="fa-solid fa-bolt"></i> Auto' : 'Resolvido'}</span>`
                : `<button class="btn-action btn-resolver-notificacao" data-id="${n.id}" title="Ver e resolver"><i class="fa-solid fa-arrow-right"></i> Resolver</button>`);

        return `
        <div class="dash-list-item ${concluida ? '' : (n.local ? 'danger' : 'warning')}" style="align-items: flex-start;">
            <div>
                <strong><i class="fa-solid ${icone}"></i> ${escapeHTML(n.titulo)}</strong><br>
                <span style="color: var(--text-light); font-size: 0.85rem;">${escapeHTML(n.mensagem)}</span><br>
                <span style="color: var(--text-light); font-size: 0.7rem;">Criado por ${escapeHTML(n.criadoPor || 'Sistema')} em ${dataFormatada}</span>
            </div>
            <div class="row-actions notif-acoes">
                ${acaoPrincipal}
                <button class="btn-action btn-delete btn-apagar-notificacao" data-id="${n.id}" title="Apagar notificação">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>`;
    }).join('');
}