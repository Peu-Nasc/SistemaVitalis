import { clinicaState } from './state.js';
import { showToast, renderCardGrid, escapeHTML } from './Ferramentas.js';

// 1. Puxa APENAS a sua conexão do arquivo local
import { db } from './firebase.js';

// 2. Puxa as ferramentas de ação do link oficial do Firebase
import { collection, addDoc, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';


// ========================================================
// AUDITORIA / ASSINATURA DIGITAL
// Toda ação relevante do sistema (criação, edição, exclusão,
// login e logout) grava um registro imutável aqui: quem fez,
// com qual perfil, quando e o que foi alterado. Acesso à tela
// é restrito ao Administrador (ver aplicarPermissoesDeTela em
// login.js).
// ========================================================

// Chamada pelos outros módulos após cada ação relevante.
// Nunca deve travar o fluxo principal: se a gravação do log falhar
// (ex: sem internet), a ação de negócio em si já foi concluída, então
// só registramos o erro no console em vez de estourar pra quem chamou.
export async function registrarAuditoria({ acao, modulo, descricao }) {
    try {
        await addDoc(collection(db, "auditoria"), {
            usuario: clinicaState.sessao.nome || 'Desconhecido',
            email: clinicaState.sessao.email || '',
            perfil: clinicaState.sessao.perfil || '',
            acao,
            modulo,
            descricao: descricao || '',
            dataHora: new Date().toISOString(),
            clinicaId: clinicaState.sessao.clinicaId
        });
    } catch (error) {
        console.error("Erro ao registrar auditoria: ", error);
    }
}

export function initAuditoria() {
    renderCardGrid('audit-mini-dash', [
        { id: 'audit-stat-total', label: 'Ações Registradas', initial: '0', variant: 'primary' },
        { id: 'audit-stat-hoje', label: 'Ações Hoje', initial: '0', variant: 'success' },
        { id: 'audit-stat-exclusoes', label: 'Exclusões', initial: '0', variant: 'danger', valueClass: 'negativo' }
    ]);

    const search = document.getElementById('search-auditoria');
    const filtroModulo = document.getElementById('filtro-modulo-auditoria');
    const filtroAcao = document.getElementById('filtro-acao-auditoria');

    function aplicarFiltros() {
        atualizarTabelaAuditoria(
            search ? search.value.toLowerCase() : '',
            filtroModulo ? filtroModulo.value : 'todos',
            filtroAcao ? filtroAcao.value : 'todas'
        );
    }

    if (search) search.addEventListener('input', aplicarFiltros);
    if (filtroModulo) filtroModulo.addEventListener('change', aplicarFiltros);
    if (filtroAcao) filtroAcao.addEventListener('change', aplicarFiltros);
}

const BADGE_ACAO = {
    'Criação': 'success',
    'Edição': 'warning',
    'Exclusão': 'danger',
    'Login': 'primary',
    'Logout': 'neutral',
    'Acesso': 'neutral'
};

export function atualizarTabelaAuditoria(filtro = '', modulo = 'todos', acao = 'todas') {
    const corpo = document.getElementById('auditoria-table-body');
    if (!corpo) return;

    const hoje = new Date().toDateString();
    let statsHoje = 0;
    let statsExclusoes = 0;

    clinicaState.auditoria.forEach(a => {
        if (new Date(a.dataHora).toDateString() === hoje) statsHoje++;
        if (a.acao === 'Exclusão') statsExclusoes++;
    });

    const filtrados = clinicaState.auditoria.filter(a => {
        const bateTexto = !filtro ||
            (a.usuario || '').toLowerCase().includes(filtro) ||
            (a.descricao || '').toLowerCase().includes(filtro);
        const bateModulo = modulo === 'todos' || a.modulo === modulo;
        const bateAcao = acao === 'todas' || a.acao === acao;
        return bateTexto && bateModulo && bateAcao;
    });

    corpo.innerHTML = filtrados.map(a => {
        const dataFormatada = a.dataHora ? new Date(a.dataHora).toLocaleString('pt-BR') : '';
        const corBadge = BADGE_ACAO[a.acao] || 'primary';

        return `<tr>
            <td><small>${dataFormatada}</small></td>
            <td>
                <strong>${escapeHTML(a.usuario)}</strong><br>
                <small style="color:#6C757D;">${escapeHTML(a.perfil || '')}</small>
            </td>
            <td>${escapeHTML(a.modulo || '')}</td>
            <td><span class="badge ${corBadge}">${escapeHTML(a.acao || '')}</span></td>
            <td>${escapeHTML(a.descricao || '')}</td>
        </tr>`;
    }).join('');

    if (filtrados.length === 0) {
        corpo.innerHTML = '<tr><td colspan="5" style="text-align:center; color:#6C757D; padding:20px;">Nenhum registro encontrado.</td></tr>';
    }

    document.getElementById('audit-stat-total').innerText = clinicaState.auditoria.length;
    document.getElementById('audit-stat-hoje').innerText = statsHoje;
    document.getElementById('audit-stat-exclusoes').innerText = statsExclusoes;
}

// Só é chamada para o perfil Administrador (ver login.js) - os demais
// perfis nem veem o botão de menu, então evitamos essa leitura pra eles.
export async function carregarAuditoria() {
    try {
        const q = query(
            collection(db, "auditoria"),
            where("clinicaId", "==", clinicaState.sessao.clinicaId)
        );
        const querySnapshot = await getDocs(q);

        clinicaState.auditoria = [];
        querySnapshot.forEach((doc) => {
            clinicaState.auditoria.push({ ...doc.data(), id: String(doc.id) });
        });

        // Mais recentes primeiro
        clinicaState.auditoria.sort((a, b) => (b.dataHora || '').localeCompare(a.dataHora || ''));

        atualizarTabelaAuditoria();
    } catch (error) {
        console.error("Erro ao buscar log de auditoria: ", error);
        showToast('Erro ao carregar o log de auditoria.', 'error');
    }
}