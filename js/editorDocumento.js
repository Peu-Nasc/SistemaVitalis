import { showToast, confirmarAcao } from './Ferramentas.js';

// ========================================================
// EDITOR DE DOCUMENTOS (texto formatado)
// Substitui o <textarea> do Gerador de Documentos por um editor com
// barra de formatação: tipo e tamanho da fonte, negrito, itálico,
// sublinhado, alinhamento (esquerda/centro/direita/justificado) e listas.
// Serve tanto para editar um modelo pronto quanto para escrever um
// documento do zero ("Documento em branco" + título personalizado).
//
// COMPATIBILIDADE: o editor mantém o id "texto-receita" e ganha uma
// propriedade .value (texto puro). Assim, o código antigo que lê/grava
// texto-receita.value (prontuario.js, pacientes.js) continua funcionando
// sem alteração. Para ler o texto FORMATADO use obterHTMLDocumento().
//
// SEGURANÇA: todo HTML que entra (modelos vindos do Firestore) ou sai
// (impressão) passa por sanitizarHTML(): só tags e estilos de uma lista
// permitida, nenhum atributo além de style filtrado.
// ========================================================

const el = (id) => document.getElementById(id);

const FONTES = {
    'Arial': "Arial, Helvetica, sans-serif",
    'Times New Roman': "'Times New Roman', Times, serif",
    'Georgia': "Georgia, serif",
    'Verdana': "Verdana, Geneva, sans-serif",
    'Tahoma': "Tahoma, Geneva, sans-serif",
    'Trebuchet MS': "'Trebuchet MS', sans-serif",
    'Courier New': "'Courier New', Courier, monospace"
};

const TAGS_PERMITIDAS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'BR', 'DIV', 'P', 'SPAN', 'UL', 'OL', 'LI', 'SUB', 'SUP']);
const TAGS_DESCARTADAS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED']);

let editor = null;
let ultimaSelecao = null;
let ultimoTextoSetado = '';
let htmlAposSet = '';

// ---------- conversões ----------
function escTexto(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function textoParaHTML(texto) {
    return String(texto ?? '').split('\n').map(escTexto).join('<br>');
}

function paraTexto(no) {
    let saida = '';
    no.childNodes.forEach(n => {
        if (n.nodeType === 3) {
            saida += n.nodeValue;
        } else if (n.nodeType === 1) {
            if (n.tagName === 'BR') {
                saida += '\n';
            } else {
                const bloco = ['DIV', 'P', 'LI', 'UL', 'OL'].includes(n.tagName);
                const interno = paraTexto(n);
                if (bloco) {
                    if (saida && !saida.endsWith('\n')) saida += '\n';
                    saida += interno + (interno.endsWith('\n') ? '' : '\n');
                } else {
                    saida += interno;
                }
            }
        }
    });
    return saida;
}

// ---------- sanitização ----------
function copiarEstiloSeguro(origem, destino) {
    const s = origem.style;
    const familia = s.fontFamily || (origem.tagName === 'FONT' ? origem.getAttribute('face') : '') || '';
    if (familia && /^[\w\s,'"\-]+$/.test(familia)) destino.style.fontFamily = familia;

    const m = /^(\d+(?:\.\d+)?)(pt|px)$/.exec(s.fontSize || '');
    if (m) {
        const pt = m[2] === 'pt' ? Number(m[1]) : Number(m[1]) * 0.75;
        if (pt >= 6 && pt <= 72) destino.style.fontSize = s.fontSize;
    }

    const alinhamento = (s.textAlign || origem.getAttribute('align') || '').toLowerCase();
    if (['left', 'right', 'center', 'justify'].includes(alinhamento)) destino.style.textAlign = alinhamento;

    if (['bold', '700', '600', '800', '900'].includes(s.fontWeight)) destino.style.fontWeight = 'bold';
    if (s.fontStyle === 'italic') destino.style.fontStyle = 'italic';
    const deco = s.textDecorationLine || s.textDecoration || '';
    if (/underline/.test(deco)) destino.style.textDecoration = 'underline';
}

function limparNo(origem, destino) {
    origem.childNodes.forEach(n => {
        if (n.nodeType === 3) {
            destino.appendChild(document.createTextNode(n.nodeValue));
        } else if (n.nodeType === 1) {
            const tag = n.tagName;
            if (TAGS_DESCARTADAS.has(tag)) return;
            if (TAGS_PERMITIDAS.has(tag) || tag === 'FONT') {
                const novo = document.createElement(tag === 'FONT' ? 'span' : tag.toLowerCase());
                copiarEstiloSeguro(n, novo);
                limparNo(n, novo);
                destino.appendChild(novo);
            } else {
                limparNo(n, destino); // tag desconhecida: mantém só o conteúdo
            }
        }
    });
}

export function sanitizarHTML(html) {
    const parsed = new DOMParser().parseFromString('<body>' + String(html ?? '') + '</body>', 'text/html');
    const caixa = document.createElement('div');
    limparNo(parsed.body, caixa);
    return caixa.innerHTML;
}

// ---------- API pública ----------
export function obterHTMLDocumento() {
    return editor ? sanitizarHTML(editor.innerHTML) : '';
}

export function definirHTMLDocumento(html) {
    if (!editor) return;
    editor.innerHTML = sanitizarHTML(html);
    ultimoTextoSetado = '';
    htmlAposSet = '';
}

export function tituloDoDocumento() {
    const tipo = el('tipo-documento-impressao')?.value || '';
    if (tipo !== 'PERSONALIZADO') return tipo;
    return (el('titulo-documento-personalizado')?.value || '').trim().toUpperCase();
}

// ---------- seleção / comandos ----------
function guardarSelecao() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
        ultimaSelecao = sel.getRangeAt(0).cloneRange();
    }
}

function restaurarSelecao() {
    editor.focus();
    if (ultimaSelecao) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(ultimaSelecao);
    }
}

function executar(cmd, valor) {
    restaurarSelecao();
    document.execCommand('styleWithCSS', false, false);
    document.execCommand(cmd, false, valor);
    guardarSelecao();
    atualizarBotoesAtivos();
}

// Fonte e tamanho valem para o trecho selecionado; sem seleção, para o
// documento inteiro (evita o "não aconteceu nada" de quem não selecionou).
function comSelecaoOuTudo(fn) {
    restaurarSelecao();
    if (!editor.textContent.trim()) {
        showToast('Escreva o texto primeiro (ou selecione um trecho) para mudar a fonte.', 'warning');
        return;
    }
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) document.execCommand('selectAll');
    document.execCommand('styleWithCSS', false, false);
    fn();
    guardarSelecao();
}

function limparEstiloDescendentes(span, propriedade) {
    span.querySelectorAll('[style]').forEach(d => d.style.removeProperty(propriedade));
}

function converterFonts(pt) {
    editor.querySelectorAll('font').forEach(f => {
        const span = document.createElement('span');
        const face = f.getAttribute('face');
        if (face) span.style.fontFamily = FONTES[face] || face;
        if (f.getAttribute('size') === '7' && pt) span.style.fontSize = pt + 'pt';
        while (f.firstChild) span.appendChild(f.firstChild);
        f.replaceWith(span);
        if (span.style.fontFamily) limparEstiloDescendentes(span, 'font-family');
        if (span.style.fontSize) limparEstiloDescendentes(span, 'font-size');
    });
}

function aplicarFonte(nome) {
    if (!nome) return;
    comSelecaoOuTudo(() => {
        document.execCommand('fontName', false, nome);
        converterFonts(null);
    });
}

function aplicarTamanho(pt) {
    const n = Number(pt);
    if (!n) return;
    comSelecaoOuTudo(() => {
        document.execCommand('fontSize', false, '7');
        converterFonts(n);
    });
}

function atualizarBotoesAtivos() {
    const barra = el('editor-doc-toolbar');
    if (!barra) return;
    const sel = window.getSelection();
    const dentro = sel && sel.rangeCount && editor.contains(sel.anchorNode);
    barra.querySelectorAll('[data-cmd]').forEach(b => {
        const cmd = b.dataset.cmd;
        if (['undo', 'redo', 'removeFormat'].includes(cmd)) return;
        let ativo = false;
        try { ativo = Boolean(dentro) && document.queryCommandState(cmd); } catch (e) { /* ignora */ }
        b.classList.toggle('ativo', ativo);
    });
}

// ---------- inicialização ----------
export function initEditorDocumento() {
    editor = el('texto-receita');
    if (!editor || editor.tagName === 'TEXTAREA') return; // HTML antigo: nada a fazer

    // .value compatível com o código que já lia/gravava o <textarea>
    Object.defineProperty(editor, 'value', {
        configurable: true,
        get() {
            if (editor.innerHTML === htmlAposSet) return ultimoTextoSetado;
            return paraTexto(editor).replace(/\n+$/, '');
        },
        set(v) {
            const texto = String(v ?? '');
            editor.innerHTML = textoParaHTML(texto);
            ultimoTextoSetado = texto;
            htmlAposSet = editor.innerHTML;
        }
    });

    const barra = el('editor-doc-toolbar');

    // mousedown nos botões não pode tirar o foco/seleção do texto
    barra.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) e.preventDefault();
    });
    barra.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-cmd]');
        if (!btn) return;
        if (btn.dataset.cmd === 'removeFormat') {
            restaurarSelecao();
            if (window.getSelection().isCollapsed) {
                showToast('Selecione o trecho para limpar a formatação.', 'warning');
                return;
            }
        }
        executar(btn.dataset.cmd);
    });

    el('ed-fonte')?.addEventListener('change', (e) => { aplicarFonte(e.target.value); e.target.value = ''; });
    el('ed-tamanho')?.addEventListener('change', (e) => { aplicarTamanho(e.target.value); e.target.value = ''; });

    document.addEventListener('selectionchange', () => {
        guardarSelecao();
        atualizarBotoesAtivos();
    });

    // Colar sempre como texto puro: não traz a formatação suja do Word/site
    editor.addEventListener('paste', (e) => {
        e.preventDefault();
        const texto = (e.clipboardData || window.clipboardData).getData('text/plain');
        document.execCommand('insertText', false, texto);
    });

    // Editor vazio de verdade (o navegador deixa um <br> sobrando) para o placeholder aparecer
    editor.addEventListener('input', () => {
        if (!editor.textContent.trim() && !editor.querySelector('li')) editor.innerHTML = '';
    });

    // Título livre quando o tipo é "Documento personalizado"
    const tipo = el('tipo-documento-impressao');
    const grupoTitulo = el('grupo-titulo-personalizado');
    if (tipo && grupoTitulo) {
        const ajustar = () => { grupoTitulo.style.display = tipo.value === 'PERSONALIZADO' ? 'block' : 'none'; };
        tipo.addEventListener('change', ajustar);
        ajustar();
    }

    // Documento em branco: começa do zero, com título personalizado
    el('btn-documento-em-branco')?.addEventListener('click', async () => {
        if (editor.textContent.trim()) {
            const ok = await confirmarAcao('Descartar o texto atual e começar um documento em branco?', {
                titulo: 'Documento em branco', textoConfirmar: 'Começar do zero', perigoso: false
            });
            if (!ok) return;
        }
        editor.innerHTML = '';
        ultimoTextoSetado = '';
        htmlAposSet = '';
        if (tipo) {
            tipo.value = 'PERSONALIZADO';
            tipo.dispatchEvent(new Event('change'));
        }
        const titulo = el('titulo-documento-personalizado');
        if (titulo) { titulo.value = ''; titulo.focus(); }
        const selModelo = el('modelo-documento-select');
        if (selModelo) {
            selModelo.value = '';
            selModelo.dispatchEvent(new Event('change'));
        }
    });
}
