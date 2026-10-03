// Precisamos importar o que formos usar de outros módulos, se necessário
import { clinicaState } from './state.js';
import { showToast } from './Ferramentas.js';
import { calcularDRE } from './financeiro.js';
import { atualizarAgenda } from './agenda.js';
import { verificarAlertasEstoque } from './estoque.js';
import { atualizarListaNotificacoes } from './notificacoes.js';
import { atualizarTabelaAuditoria } from './auditoria.js';

const TITULOS_CARD_INICIO = {
    dashboard: 'Dashboard & DRE',
    agenda: 'Agenda',
    pacientes: 'Pacientes & Prontuários',
    estoque: 'Estoque (Anvisa)',
    financeiro: 'Financeiro',
    notificacoes: 'Notificações',
    auditoria: 'Auditoria',
    ajuda: 'Ajuda'
};

const ICONES_CARD_INICIO = {
    dashboard: 'fa-solid fa-chart-line',
    agenda: 'fa-regular fa-calendar-days',
    pacientes: 'fa-solid fa-users',
    estoque: 'fa-solid fa-boxes-stacked',
    financeiro: 'fa-solid fa-cash-register',
    notificacoes: 'fa-solid fa-bell',
    auditoria: 'fa-solid fa-file-signature',
    ajuda: 'fa-solid fa-circle-question'
};

const DESCRICOES_CARD_INICIO = {
    dashboard: 'Resultado financeiro e indicadores gerais da clínica',
    agenda: 'Marcar, confirmar e acompanhar as consultas do dia',
    pacientes: 'Prontuários, histórico e cadastro de pacientes',
    estoque: 'Controle de medicamentos e materiais por lote',
    financeiro: 'Livro Caixa, Custos Fixos, Procedimentos e Pacotes',
    notificacoes: 'Pendências que precisam da sua atenção',
    auditoria: 'Histórico de ações realizadas no sistema',
    ajuda: 'Dúvidas rápidas sobre como usar o sistema'
};

// Tela de Início: um card de atalho pra cada módulo que o perfil logado
// efetivamente enxerga no menu lateral. Em vez de duplicar as regras de
// permissão aqui, a função só olha quais botões do menu já estão visíveis
// (aplicarPermissoesDeTela, em login.js, roda antes e decide isso) - então
// a tela de Início nunca fica dessincronizada de quem pode ver o quê.
export function renderizarCardsInicio() {
    const container = document.getElementById('inicio-cards');
    if (!container) return;

    const botoesVisiveis = Array.from(document.querySelectorAll('.menu-btn')).filter(btn => {
        const target = btn.getAttribute('data-target');
        if (target === 'inicio') return false;
        return window.getComputedStyle(btn).display !== 'none';
    });

    container.innerHTML = botoesVisiveis.map(btn => {
        const target = btn.getAttribute('data-target');
        return `
            <div class="card card-action inicio-card" data-target="${target}">
                <i class="${ICONES_CARD_INICIO[target] || 'fa-solid fa-circle'} hub-icon"></i>
                <h3>${TITULOS_CARD_INICIO[target] || target}</h3>
                <p class="top-subtitle mt-15">${DESCRICOES_CARD_INICIO[target] || ''}</p>
            </div>`;
    }).join('');

    container.querySelectorAll('.inicio-card').forEach(card => {
        card.addEventListener('click', () => {
            document.querySelector(`.menu-btn[data-target="${card.dataset.target}"]`)?.click();
        });
    });
}

// ========================================================
// ABAS no lugar dos "hubs" (Pacientes/Equipe e Financeiro)
// Antes: Menu > hub com cards > área > "Voltar". Agora: abas fixas no
// topo da tela, um clique pra trocar e sem botão Voltar. Reaproveita os
// cards/áreas/handlers que já existem (inclusive as travas por perfil
// feitas em login.js, que escondem o card - a aba some junto), então
// nenhuma regra de permissão foi duplicada aqui.
// ========================================================
const CONFIG_ABAS = {
    pacientes: {
        hub: 'hub-principal',
        areas: ['area-pacientes', 'area-profissionais'],
        itens: [
            { card: 'btn-hub-pacientes', area: 'area-pacientes', label: 'Pacientes', icone: 'fa-solid fa-users' },
            { card: 'btn-hub-profissionais', area: 'area-profissionais', label: 'Equipe', icone: 'fa-solid fa-user-doctor' }
        ]
    },
    financeiro: {
        hub: 'hub-financeiro',
        areas: ['area-livro-caixa', 'area-custos-fixos', 'area-procedimentos', 'area-pacotes'],
        itens: [
            { card: 'btn-hub-livro-caixa', area: 'area-livro-caixa', label: 'Livro Caixa', icone: 'fa-solid fa-cash-register' },
            { card: 'btn-hub-custos-fixos', area: 'area-custos-fixos', label: 'Custos Fixos', icone: 'fa-solid fa-file-invoice-dollar' },
            { card: 'btn-hub-procedimentos', area: 'area-procedimentos', label: 'Procedimentos', icone: 'fa-solid fa-tags' },
            { card: 'btn-hub-pacotes', area: 'area-pacotes', label: 'Pacotes', icone: 'fa-solid fa-box-open' }
        ]
    }
};

function marcarAbaAtiva(barra, areaId) {
    barra.querySelectorAll('.nav-tab').forEach(b => {
        const ativa = b.dataset.area === areaId;
        b.classList.toggle('active', ativa);
        b.setAttribute('aria-selected', ativa ? 'true' : 'false');
    });
}

function selecionarAba(secao, item, barra) {
    const cfg = CONFIG_ABAS[secao];
    const areaAtual = document.getElementById(item.area);
    if (areaAtual && areaAtual.style.display === 'block') return; // já está nela

    cfg.areas.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    // Prontuário aberto fica fora das áreas: fecha ao trocar de aba
    if (secao === 'pacientes') {
        const pep = document.getElementById('prontuario-ativo');
        if (pep) pep.style.display = 'none';
    }
    document.getElementById(item.card)?.click(); // reaproveita o handler original
    marcarAbaAtiva(barra, item.area);
}

export function renderizarAbas(secao) {
    const cfg = CONFIG_ABAS[secao];
    const hub = cfg && document.getElementById(cfg.hub);
    if (!hub) return;

    hub.classList.add('hub-como-abas'); // esconde os cards grandes (ver CSS)

    let barra = document.getElementById('abas-' + secao);
    if (!barra) {
        barra = document.createElement('div');
        barra.id = 'abas-' + secao;
        barra.className = 'nav-tabs';
        barra.setAttribute('role', 'tablist');
        hub.parentNode.insertBefore(barra, hub);
        barra.addEventListener('click', (e) => {
            const btn = e.target.closest('.nav-tab');
            if (!btn) return;
            const item = cfg.itens.find(i => i.area === btn.dataset.area);
            if (item) selecionarAba(secao, item, barra);
        });
    }

    // Só entra aba cujo card o perfil logado pode ver
    const visiveis = cfg.itens.filter(i => {
        const card = document.getElementById(i.card);
        return card && card.style.display !== 'none';
    });

    barra.innerHTML = visiveis.map(i => `
        <button type="button" class="nav-tab" role="tab" data-area="${i.area}">
            <i class="${i.icone}"></i> ${i.label}
        </button>`).join('');
    barra.style.display = visiveis.length > 1 ? 'flex' : 'none';

    const aberta = visiveis.find(i => document.getElementById(i.area)?.style.display === 'block');
    if (aberta) marcarAbaAtiva(barra, aberta.area);
    else if (visiveis.length) selecionarAba(secao, visiveis[0], barra);
}

export function initUI() {
    const sidebar = document.getElementById('sidebar');
    const mobileMenuToggle = document.getElementById('mobile-menu-toggle');
    const mobileBackdrop = document.getElementById('mobile-backdrop');

    function fecharMenuMobile() {
        if (sidebar) sidebar.classList.remove('active');
        if (mobileBackdrop) mobileBackdrop.classList.remove('active');
    }

    if (mobileMenuToggle) {
        mobileMenuToggle.addEventListener('click', () => {
            sidebar.classList.toggle('active');
            mobileBackdrop.classList.toggle('active');
        });
    }

    if (mobileBackdrop) {
        mobileBackdrop.addEventListener('click', fecharMenuMobile);
    }

    // Lógica de navegação da SPA
    document.querySelectorAll('.menu-btn').forEach(button => {
        button.addEventListener('click', (e) => {
            const target = e.currentTarget.getAttribute('data-target');

            // Trava de acesso real (não só visual): mesmo que alguém force o
            // clique/hash pra "auditoria", só o Administrador consegue trocar
            // de fato de aba - os demais perfis nem veem o botão, mas essa
            // segunda barreira evita depender só do CSS/display do menu.
            if (target === 'auditoria' && clinicaState.sessao.perfil !== 'admin') {
                showToast('Acesso restrito ao Administrador.', 'error');
                return;
            }

            document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));
            document.querySelectorAll('.menu-btn').forEach(btn => btn.classList.remove('active'));
            
            document.getElementById(target).classList.add('active');
            e.currentTarget.classList.add('active');
            fecharMenuMobile();
            
            // Dispara funções específicas ao trocar de aba
            if (target === 'inicio') renderizarCardsInicio();
            if (target === 'pacientes' || target === 'financeiro') renderizarAbas(target);
            if (target === 'estoque') verificarAlertasEstoque();
            if (target === 'dashboard') calcularDRE();
            if (target === 'agenda') atualizarAgenda();
            if (target === 'notificacoes') atualizarListaNotificacoes(document.getElementById('filtro-notificacoes')?.value || 'pendentes');
            if (target === 'auditoria') atualizarTabelaAuditoria();
        });
    });


    // === NAVEGAÇÃO INTERNA DO HUB DE PACIENTES/EQUIPE ===
    const hubPrincipal = document.getElementById('hub-principal');
    const areaPacientes = document.getElementById('area-pacientes');
    const areaProfissionais = document.getElementById('area-profissionais');

    document.getElementById('btn-hub-pacientes')?.addEventListener('click', () => {
        hubPrincipal.style.display = 'none';
        areaPacientes.style.display = 'block';
    });

    document.getElementById('btn-hub-profissionais')?.addEventListener('click', () => {
        if (clinicaState.sessao.perfil === 'Doutor(a)') {
            showToast('Gestão da equipe é restrita à Administração.', 'error');
            return;
        }
        hubPrincipal.style.display = 'none';
        areaProfissionais.style.display = 'block';
    });

    // Botões de voltar para a tela inicial dos botões grandes
    document.querySelectorAll('.btn-voltar-hub').forEach(btn => {
        btn.addEventListener('click', () => {
            areaPacientes.style.display = 'none';
            areaProfissionais.style.display = 'none';
            hubPrincipal.style.display = 'flex'; // Volta a mostrar os cards
            
            // Bônus: Se o prontuário estiver aberto, fecha ele ao voltar
            const pep = document.getElementById('prontuario-ativo');
            if (pep) pep.style.display = 'none';
        });
    });

    // === NAVEGAÇÃO INTERNA DO HUB FINANCEIRO (Livro Caixa / Custos Fixos) ===
    const hubFinanceiro = document.getElementById('hub-financeiro');
    const areaLivroCaixa = document.getElementById('area-livro-caixa');
    const areaCustosFixos = document.getElementById('area-custos-fixos');
    const areaProcedimentos = document.getElementById('area-procedimentos');
    const areaPacotes = document.getElementById('area-pacotes');

    document.getElementById('btn-hub-livro-caixa')?.addEventListener('click', () => {
        hubFinanceiro.style.display = 'none';
        areaLivroCaixa.style.display = 'block';
    });

    document.getElementById('btn-hub-custos-fixos')?.addEventListener('click', () => {
        hubFinanceiro.style.display = 'none';
        areaCustosFixos.style.display = 'block';
    });

    document.getElementById('btn-hub-procedimentos')?.addEventListener('click', () => {
        hubFinanceiro.style.display = 'none';
        areaProcedimentos.style.display = 'block';
    });

    document.getElementById('btn-hub-pacotes')?.addEventListener('click', () => {
        hubFinanceiro.style.display = 'none';
        areaPacotes.style.display = 'block';
    });

    document.querySelectorAll('.btn-voltar-hub-financeiro').forEach(btn => {
        btn.addEventListener('click', () => {
            areaLivroCaixa.style.display = 'none';
            areaCustosFixos.style.display = 'none';
            areaProcedimentos.style.display = 'none';
            areaPacotes.style.display = 'none';
            hubFinanceiro.style.display = 'flex';
        });
    });
    // Lógica para fechar modais no ESC ou clique fora...
}