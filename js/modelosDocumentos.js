import { clinicaState } from './state.js';
import { showToast, escapeHTML, comEstadoDeCarregamento, confirmarAcao } from './Ferramentas.js';
import { db } from './firebase.js';
import { collection, addDoc, getDocs, doc, updateDoc, deleteDoc, query, where } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { registrarAuditoria } from './auditoria.js';
import { obterHTMLDocumento, definirHTMLDocumento } from './editorDocumento.js';

// ========================================================
// MODELOS DE DOCUMENTOS (receituários, laudos, relatórios...)
// Pedido do Dr. Aroldo: cada profissional (oftalmologista, TO,
// psicólogo, pediatra...) cria os próprios modelos e todos da clínica
// podem usá-los, sem depender do administrador. Ao escolher um modelo
// no Gerador de Documentos (aba "Documentos e Receituário" do
// prontuário), o texto cai pronto no campo de conteúdo e o médico só
// ajusta antes de imprimir.
//
// COLEÇÃO: "modelos_documentos" (filtrada por clinicaId, como as demais).
//   { titulo, texto (puro), html (formatado), tipoDocumento, tituloPersonalizado, clinicaId, criadoPorNome,
//     criadoPorEmail, criadoPorPerfil, criadoEm, atualizadoEm }
//
// VARIÁVEIS no texto do modelo (trocadas na hora de aplicar):
//   {{paciente}}  {{data}}  {{profissional}}
//
// PERMISSÕES: admin e Doutor(a) criam. Editar/excluir: o autor ou o admin.
// NÃO coloque dados de paciente dentro de modelos - eles são texto
// compartilhado da clínica (o nome do paciente é trocado por {{paciente}}
// automaticamente ao salvar).
// ========================================================

const COLECAO = 'modelos_documentos';
let pacienteAtual = null;

const el = (id) => document.getElementById(id);

function perfilPodeCriar() {
    const p = clinicaState.sessao.perfil;
    return p === 'admin' || p === 'Doutor(a)';
}

function podeGerenciar(modelo) {
    if (!modelo) return false;
    if (clinicaState.sessao.perfil === 'admin') return true;
    const email = (clinicaState.sessao.email || '').trim().toLowerCase();
    return Boolean(email) && (modelo.criadoPorEmail || '').trim().toLowerCase() === email;
}

function modeloSelecionado() {
    const id = el('modelo-documento-select')?.value;
    if (!id) return null;
    return clinicaState.modelosDocumentos.find(m => String(m.id) === String(id)) || null;
}

function rotulosDosTipos() {
    const mapa = {};
    document.querySelectorAll('#tipo-documento-impressao option').forEach(o => {
        mapa[o.value] = o.textContent.trim();
    });
    return mapa;
}

function escTexto(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// comoHTML: o texto é HTML do editor, então os valores entram escapados
function aplicarVariaveis(texto, comoHTML = false) {
    const profId = el('pep-profissional')?.value;
    const prof = clinicaState.profissionais.find(p => String(p.id) === String(profId));
    const hoje = new Date().toLocaleDateString('pt-BR');
    const f = (s) => comoHTML ? escTexto(s) : s;
    return String(texto || '')
        .replace(/\{\{\s*paciente\s*\}\}/gi, () => f(pacienteAtual?.nome || '[paciente]'))
        .replace(/\{\{\s*data\s*\}\}/gi, () => f(hoje))
        .replace(/\{\{\s*profissional\s*\}\}/gi, () => f(prof?.nome || '[profissional]'));
}

// Ao salvar, troca o nome do paciente em atendimento por {{paciente}} -
// assim o modelo serve pra qualquer pessoa e não vaza dado de ninguém.
function generalizarTexto(texto, comoHTML = false) {
    const nome = (pacienteAtual?.nome || '').trim();
    if (nome.length < 3) return texto;
    return texto.split(comoHTML ? escTexto(nome) : nome).join('{{paciente}}');
}

function atualizarBotoes() {
    const btnExcluir = el('btn-excluir-modelo-doc');
    if (btnExcluir) btnExcluir.style.display = podeGerenciar(modeloSelecionado()) ? '' : 'none';
}

function renderizarSeletor(valorDesejado) {
    const sel = el('modelo-documento-select');
    if (!sel) return;

    const valor = valorDesejado !== undefined ? valorDesejado : sel.value;
    const rotulos = rotulosDosTipos();
    const modelos = clinicaState.modelosDocumentos;

    const grupos = {};
    modelos.forEach(m => {
        const t = m.tipoDocumento || '';
        (grupos[t] = grupos[t] || []).push(m);
    });

    let html = `<option value="">${modelos.length ? 'Selecione um modelo...' : 'Nenhum modelo salvo ainda'}</option>`;
    Object.keys(grupos).sort().forEach(t => {
        html += `<optgroup label="${escapeHTML(rotulos[t] || 'Outros')}">` +
            grupos[t].map(m => `<option value="${escapeHTML(m.id)}">${escapeHTML(m.titulo)}</option>`).join('') +
            '</optgroup>';
    });
    sel.innerHTML = html;
    sel.value = modelos.some(m => String(m.id) === String(valor)) ? valor : '';
    atualizarBotoes();
}

// Chamada por pacientes.js sempre que um prontuário é aberto: guarda o
// paciente (pras variáveis) e zera a seleção pra não arrastar o modelo
// de um atendimento pro outro.
export function resetarSeletorModelo(paciente) {
    pacienteAtual = paciente || null;
    renderizarSeletor('');
}

export async function carregarModelosDocumentos() {
    try {
        const q = query(
            collection(db, COLECAO),
            where("clinicaId", "==", clinicaState.sessao.clinicaId)
        );
        const snap = await getDocs(q);

        clinicaState.modelosDocumentos = [];
        snap.forEach((d) => {
            clinicaState.modelosDocumentos.push({ ...d.data(), id: String(d.id) });
        });
        clinicaState.modelosDocumentos.sort((a, b) => (a.titulo || '').localeCompare(b.titulo || ''));

        renderizarSeletor();
    } catch (error) {
        console.error("Erro ao buscar modelos de documentos: ", error);
        showToast('Não foi possível carregar os modelos de documentos.', 'warning');
    }
}

export function initModelosDocumentos() {
    const grupo = el('grupo-modelos-documento');
    const sel = el('modelo-documento-select');
    if (!grupo || !sel) return;

    const modal = el('modal-modelo-doc');
    const form = el('form-modelo-doc');
    const campoTitulo = el('modelo-titulo');
    const linhaAtualizar = el('modelo-linha-atualizar');
    const chkAtualizar = el('modelo-atualizar');

    // Quem não cria modelos (ex: recepção) nem enxerga os botões de salvar
    const podeCriar = perfilPodeCriar;

    // ---- aplicar um modelo escolhido ----
    sel.addEventListener('change', async () => {
        atualizarBotoes();
        const modelo = modeloSelecionado();
        if (!modelo) return;

        const texto = el('texto-receita');
        if (texto.value.trim()) {
            const ok = await confirmarAcao('Já existe texto no documento. Substituir pelo modelo escolhido?', {
                titulo: 'Usar modelo', textoConfirmar: 'Substituir', perigoso: false
            });
            if (!ok) {
                sel.value = '';
                atualizarBotoes();
                return;
            }
        }

        // Ajusta o tipo do documento (e o que depende dele) e depois põe o texto
        const tipo = el('tipo-documento-impressao');
        if (modelo.tipoDocumento && Array.from(tipo.options).some(o => o.value === modelo.tipoDocumento)) {
            tipo.value = modelo.tipoDocumento;
            tipo.dispatchEvent(new Event('change'));
        }
        const titulo = el('titulo-documento-personalizado');
        if (titulo) titulo.value = modelo.tituloPersonalizado || '';

        if (modelo.html) {
            definirHTMLDocumento(aplicarVariaveis(modelo.html, true));
        } else {
            texto.value = aplicarVariaveis(modelo.texto); // modelo antigo, só texto
        }
        texto.focus();
    });

    // ---- abrir o modal de salvar ----
    el('btn-salvar-modelo-doc')?.addEventListener('click', () => {
        if (!podeCriar()) return showToast('Seu perfil não pode criar modelos.', 'error');
        if (!el('texto-receita').value.trim()) {
            return showToast('Escreva o texto do documento antes de salvar como modelo.', 'warning');
        }

        const atual = modeloSelecionado();
        const editavel = podeGerenciar(atual);
        campoTitulo.value = atual ? atual.titulo : '';
        linhaAtualizar.style.display = editavel ? 'flex' : 'none';
        chkAtualizar.checked = editavel;
        modal.classList.add('active');
        campoTitulo.focus();
    });

    const fecharModal = () => {
        modal.classList.remove('active');
        form.reset();
    };
    el('btn-close-modelo-doc')?.addEventListener('click', fecharModal);
    el('btn-cancelar-modelo-doc')?.addEventListener('click', fecharModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) fecharModal(); });

    // ---- salvar (novo ou atualizar) ----
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!podeCriar()) return;

        const btn = form.querySelector('button[type="submit"]');
        await comEstadoDeCarregamento(btn, 'Salvando...', async () => {
            const titulo = campoTitulo.value.trim();
            const texto = generalizarTexto(el('texto-receita').value.trim());
            const html = generalizarTexto(obterHTMLDocumento(), true);
            const tipoDocumento = el('tipo-documento-impressao').value;
            const tituloPersonalizado = tipoDocumento === 'PERSONALIZADO'
                ? (el('titulo-documento-personalizado')?.value || '').trim() : '';
            if (!titulo || !texto) return showToast('Informe o nome e o texto do modelo.', 'warning');

            const atual = modeloSelecionado();
            const atualizar = Boolean(atual) && chkAtualizar.checked && podeGerenciar(atual);
            const agora = new Date().toISOString();

            try {
                let idFinal;
                if (atualizar) {
                    await updateDoc(doc(db, COLECAO, atual.id), { titulo, texto, html, tipoDocumento, tituloPersonalizado, atualizadoEm: agora });
                    idFinal = atual.id;
                    showToast('Modelo atualizado.', 'success');
                    await registrarAuditoria({ acao: 'Edição', modulo: 'Prontuário', descricao: `Modelo de documento atualizado: ${titulo}` });
                } else {
                    const ref = await addDoc(collection(db, COLECAO), {
                        titulo, texto, html, tipoDocumento, tituloPersonalizado,
                        clinicaId: clinicaState.sessao.clinicaId,
                        criadoPorNome: clinicaState.sessao.nome || '',
                        criadoPorEmail: clinicaState.sessao.email || '',
                        criadoPorPerfil: clinicaState.sessao.perfil || '',
                        criadoEm: agora,
                        atualizadoEm: agora
                    });
                    idFinal = ref.id;
                    showToast('Modelo salvo e disponível para a clínica.', 'success');
                    await registrarAuditoria({ acao: 'Criação', modulo: 'Prontuário', descricao: `Novo modelo de documento: ${titulo}` });
                }

                fecharModal();
                await carregarModelosDocumentos();
                renderizarSeletor(String(idFinal));
            } catch (error) {
                console.error("Erro ao salvar modelo: ", error);
                showToast('Falha ao salvar o modelo.', 'error');
            }
        });
    });

    // ---- excluir ----
    el('btn-excluir-modelo-doc')?.addEventListener('click', async () => {
        const modelo = modeloSelecionado();
        if (!modelo || !podeGerenciar(modelo)) return;

        const ok = await confirmarAcao(`Excluir o modelo "${modelo.titulo}"? Ele deixa de aparecer para toda a clínica.`, {
            titulo: 'Excluir modelo', textoConfirmar: 'Excluir'
        });
        if (!ok) return;

        try {
            await deleteDoc(doc(db, COLECAO, modelo.id));
            showToast('Modelo excluído.', 'success');
            await registrarAuditoria({ acao: 'Exclusão', modulo: 'Prontuário', descricao: `Modelo de documento excluído: ${modelo.titulo}` });
            await carregarModelosDocumentos();
            renderizarSeletor('');
        } catch (error) {
            console.error("Erro ao excluir modelo: ", error);
            showToast('Falha ao excluir o modelo.', 'error');
        }
    });
}

// Chamada por login.js depois que a sessão existe: mostra ou esconde o
// bloco de modelos conforme o perfil.
export function aplicarPermissaoModelos() {
    const grupo = el('grupo-modelos-documento');
    if (!grupo) return;
    const btnSalvar = el('btn-salvar-modelo-doc');
    if (btnSalvar) btnSalvar.style.display = perfilPodeCriar() ? '' : 'none';
}