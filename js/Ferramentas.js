// Aqui colocamos tudo que é usado em vários lugares do sistema
import { clinicaState } from './state.js';

export const formatCurrency = (val) => {
    const num = Number(val);
    if (isNaN(num)) return 'R$ 0,00';
    return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

export function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icon = document.createElement('i');
    icon.className = `fa-solid ${type === 'error' ? 'fa-circle-xmark' : type === 'warning' ? 'fa-triangle-exclamation' : 'fa-circle-check'}`;

    // Usamos textContent (em vez de inserir a mensagem via innerHTML) para que
    // esta função seja segura por padrão, mesmo quando a mensagem contiver
    // dado digitado pelo usuário (nome de paciente, item de estoque, etc.)
    const span = document.createElement('span');
    span.textContent = message;

    toast.appendChild(icon);
    toast.appendChild(document.createTextNode(' '));
    toast.appendChild(span);

    container.appendChild(toast);

    // Tempo na tela: quanto maior a mensagem, mais tempo; avisos e erros
    // ficam mais, porque a pessoa precisa ler com calma.
    // (ajuste os números aqui para deixar mais rápido ou mais lento)
    const base = { success: 5000, info: 6000, warning: 8000, error: 9000 }[type] || 5000;
    const duracao = Math.min(base + message.length * 30, 15000);

    let temporizador = null;
    const fechar = () => {
        clearTimeout(temporizador);
        toast.classList.add('saindo');
        setTimeout(() => toast.remove(), 300);
    };
    const agendar = (ms) => {
        clearTimeout(temporizador);
        temporizador = setTimeout(fechar, ms);
    };

    agendar(duracao);
    // Passar o mouse por cima pausa a contagem; clicar fecha na hora
    toast.addEventListener('mouseenter', () => clearTimeout(temporizador));
    toast.addEventListener('mouseleave', () => agendar(2500));
    toast.addEventListener('click', fechar);
}

export function escapeHTML(str) {
    // Aceita número, null ou undefined sem quebrar a tela (antes só aceitava texto)
    return String(str ?? '').replace(/[&<>'"]/g, tag => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[tag] || tag));
}

// ========================================================
// CRIPTOGRAFIA (centralizada - antes cada arquivo calculava
// a própria chave e reimplementava encriptar/decriptar)
// ========================================================
function obterChaveSecreta() {
    return "GestaoPRO_" + clinicaState.sessao.clinicaId;
}

export function encriptar(texto) {
    if (!texto) return '';
    return CryptoJS.AES.encrypt(texto, obterChaveSecreta()).toString();
}

export function decriptar(textoCripto) {
    if (!textoCripto) return '';
    try {
        const bytes = CryptoJS.AES.decrypt(textoCripto, obterChaveSecreta());
        const original = bytes.toString(CryptoJS.enc.Utf8);
        return original || textoCripto;
    } catch (e) {
        return textoCripto;
    }
}

// ========================================================
// MODAL DE CONFIRMAÇÃO (substitui o confirm() nativo do
// navegador por um modal com a cara do sistema)
// ========================================================
let resolverConfirmacao = null;

export function initConfirmacao() {
    const modal = document.getElementById('modal-confirmacao');
    const btnCancelar = document.getElementById('btn-confirmacao-cancelar');
    const btnConfirmar = document.getElementById('btn-confirmacao-confirmar');
    if (!modal || !btnCancelar || !btnConfirmar) return;

    const fechar = (resultado) => {
        modal.classList.remove('active');
        if (resolverConfirmacao) {
            resolverConfirmacao(resultado);
            resolverConfirmacao = null;
        }
    };

    btnCancelar.addEventListener('click', () => fechar(false));
    btnConfirmar.addEventListener('click', () => fechar(true));

    // Clicar fora do card ou apertar ESC cancela, igual ao confirm() nativo
    modal.addEventListener('click', (e) => {
        if (e.target === modal) fechar(false);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('active')) fechar(false);
    });
}

// Uso: if (await confirmarAcao('Deseja excluir?')) { ... }
// opcoes: { titulo, textoConfirmar, perigoso } - perigoso (default true) deixa o botão de confirmar vermelho
export function confirmarAcao(mensagem, opcoes = {}) {
    const modal = document.getElementById('modal-confirmacao');
    const elMensagem = document.getElementById('confirmacao-mensagem');
    const elTitulo = document.getElementById('confirmacao-titulo');
    const btnConfirmar = document.getElementById('btn-confirmacao-confirmar');

    elMensagem.textContent = mensagem;
    elTitulo.textContent = opcoes.titulo || 'Confirmar ação';
    btnConfirmar.textContent = opcoes.textoConfirmar || 'Confirmar';
    btnConfirmar.classList.toggle('danger', opcoes.perigoso !== false);

    modal.classList.add('active');

    return new Promise((resolve) => {
        resolverConfirmacao = resolve;
    });
}

// ========================================================
// RODAPÉ INSTITUCIONAL (autoria / LGPD / termos de uso)
// Marca d'água fixa do sistema - mostra o ano atual e abre o
// modal com o texto completo de direitos autorais e LGPD.
// ========================================================
export function initFooterInstitucional() {
    const elAno = document.getElementById('footer-ano-atual');
    if (elAno) elAno.textContent = new Date().getFullYear();

    const modal = document.getElementById('modal-termos');
    const btnAbrir = document.getElementById('btn-abrir-termos');
    const btnFechar = document.getElementById('btn-close-termos');
    if (!modal || !btnAbrir) return;

    btnAbrir.addEventListener('click', () => modal.classList.add('active'));
    if (btnFechar) btnFechar.addEventListener('click', () => modal.classList.remove('active'));
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('active');
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('active')) modal.classList.remove('active');
    });
}

// ========================================================
// ESTADO DE CARREGAMENTO DE BOTÃO (antes repetido em todo
// formulário: guardar innerHTML, trocar por spinner, desabilitar,
// e no final restaurar - agora é uma linha só)
// ========================================================
export async function comEstadoDeCarregamento(botao, textoCarregando, fn) {
    const textoOriginal = botao.innerHTML;
    botao.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${textoCarregando}`;
    botao.disabled = true;
    try {
        await fn();
    } finally {
        botao.innerHTML = textoOriginal;
        botao.disabled = false;
    }
}

// Renderiza um grid de cards de indicador (usado no dashboard, financeiro e estoque)
// cards: [{ id, label, initial, variant: 'success'|'danger'|'warning'|'primary', valueClass, compact }]
export function renderCardGrid(containerId, cards) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = cards.map(c => `
        <div class="card card-info${c.variant ? ' card-' + c.variant : ''}${c.compact ? ' card-compact' : ''}">
            <h3>${c.label}</h3>
            <p class="big-number${c.valueClass ? ' ' + c.valueClass : ''}" id="${c.id}">${c.initial ?? ''}</p>
        </div>
    `).join('');
}

// Inicialização das máscaras do IMask
export function initMasks() {
    const maskOptions = {
        cpf: { mask: '000.000.000-00' },
        telefone: { mask: '(00) 00000-0000' },
        moeda: { mask: Number, scale: 2, thousandsSeparator: '.', padFractionalZeros: true, normalizeZeros: true, radix: ',' }
    };
    
    IMask(document.getElementById('cad-cpf-check'), maskOptions.cpf);
    IMask(document.getElementById('cad-cpf'), maskOptions.cpf);
    IMask(document.getElementById('cad-tel'), maskOptions.telefone);
    IMask(document.getElementById('fin-valor'), maskOptions.moeda);
    if (document.getElementById('fr-valor')) IMask(document.getElementById('fr-valor'), maskOptions.moeda);
    IMask(document.getElementById('custo-valor'), maskOptions.moeda);
    IMask(document.getElementById('proc-valor'), maskOptions.moeda);
    if (document.getElementById('pac-valor')) IMask(document.getElementById('pac-valor'), maskOptions.moeda);
}

// Aplica a máscara de moeda num input criado dinamicamente depois do
// carregamento da página (ex: linha de exceção de preço por profissional
// na Tabela de Procedimentos) - initMasks() só cobre o que já existe no
// HTML no momento em que a página carrega.
export function aplicarMascaraMoeda(input) {
    IMask(input, { mask: Number, scale: 2, thousandsSeparator: '.', padFractionalZeros: true, normalizeZeros: true, radix: ',' });
}