import { initAuth } from './login.js';
import { initUI } from './NavMenu.js';
import { initMasks, initConfirmacao, initFooterInstitucional } from './Ferramentas.js';
import { initPacientes, atualizarTabelaPacientes, carregarPacientes } from './pacientes.js';
import { initFinanceiro, calcularDRE, atualizarTabelaFinanceiro, atualizarTabelaCustosFixos } from './financeiro.js';
import { initEstoque, atualizarTabelaEstoque } from './estoque.js';
import { initProcedimentos } from './procedimentos.js';
import { initPacotes } from './pacotes.js';
import { initAgenda, atualizarAgenda } from './agenda.js';
import { initNotificacoes } from './notificacoes.js';
import { initAuditoria } from './auditoria.js';
import { initAjuda } from './ajuda.js';

// ========================================================
// TRAVA ANTI-SPAM (PREVENÇÃO DE MÚLTIPLAS REQUISIÇÕES)
// Cria um intervalo (cooldown) obrigatório entre cliques repetidos
// NO MESMO botão. Antes o cronômetro era único pra qualquer botão
// do sistema - isso bloqueava silenciosamente cliques legítimos em
// botões DIFERENTES feitos em sequência rápida (ex: abrir um modal
// e já clicar em "Confirmar"), inclusive travando envios de
// formulário sem mostrar erro nenhum. Agora o cooldown é por botão.
// ========================================================
const ultimosCliquesPorBotao = new WeakMap();
document.addEventListener('click', (e) => {
    // Verifica se o que foi clicado é um botão ou um ícone dentro dele
    const btn = e.target.closest('button');
    if (btn) {
        const agora = Date.now();
        const ultimoCliqueNesseBotao = ultimosCliquesPorBotao.get(btn) || 0;
        // Se o último clique NESSE MESMO botão foi há menos de 800ms, bloqueia!
        if (agora - ultimoCliqueNesseBotao < 800) {
            e.preventDefault();     // Impede o formulário de ser enviado
            e.stopPropagation();    // Impede o JavaScript de executar a ação
            return;
        }
        ultimosCliquesPorBotao.set(btn, agora);
    }
}, true); // O parâmetro 'true' força essa verificação a rodar ANTES das outras

document.addEventListener('DOMContentLoaded', () => {
    initAuth();

    initMasks();
    initUI();
    initConfirmacao();
    initFooterInstitucional();

    initPacientes();
    initFinanceiro();
    initEstoque();
    initProcedimentos();
    initPacotes();
    initAgenda();
    initNotificacoes();
    initAuditoria();
    initAjuda();

    calcularDRE();
    atualizarTabelaFinanceiro();
    atualizarTabelaCustosFixos();
    atualizarTabelaEstoque();
    atualizarAgenda();
});