import { clinicaState } from './state.js';
import { showToast, comEstadoDeCarregamento, escapeHTML } from './Ferramentas.js';
import { db } from './firebase.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { registrarAuditoria } from './auditoria.js';

// Padrão para clínicas que ainda não têm o objeto "features" no Firestore.
// O que for geral do VITALIS fica true; o que for nichado/exclusivo fica false.
const FEATURES_PADRAO = {
    estoqueAnvisa: true,
    pacotesMultiprofissionais: true,
    precoDuploEspecieCartao: false,
    blocoOftalmologia: false,
    escalaPersonalizada: true,
    multiplosProcedimentos: true,
    fechamentoDiario: true
};

// Use no JS: if (temFeature('precoDuploEspecieCartao')) { ... }
export function temFeature(nome) {
    if (clinicaState.features && typeof clinicaState.features[nome] === 'boolean') {
        return clinicaState.features[nome];
    }
    return FEATURES_PADRAO[nome] === true;
}

// Esconde ou mostra qualquer elemento HTML que tenha o atributo data-feature="..."
export function aplicarFeaturesNaTela() {
    document.querySelectorAll('[data-feature]').forEach((el) => {
        const flag = el.getAttribute('data-feature');
        if (!temFeature(flag)) {
            el.style.display = 'none';
        }
    });
}

// Converte qualquer imagem (Logo ou Avatar) em Base64 comprimido (~15KB a 30KB)
export function imagemParaBase64Comprimido(file, larguraMax = 360, qualidade = 0.8) {
    return new Promise((resolve, reject) => {
        if (!file || !file.type.startsWith('image/')) {
            return reject(new Error('Selecione um arquivo de imagem válido.'));
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const proporcao = img.width > larguraMax ? larguraMax / img.width : 1;
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(img.width * proporcao);
                canvas.height = Math.round(img.height * proporcao);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                // PNG mantém fundo transparente para logos; JPEG comprime fotos
                const tipoSaida = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
                resolve(canvas.toDataURL(tipoSaida, qualidade));
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}


//Passo 3: Marcar os elementos no app.html (e checar no JS quando precisar)
//Agora você controla qualquer coisa — de um módulo inteiro a uma gaveta interna do prontuário — apenas colocando data-feature="nomeDaFlag" no HTML:
//E quando a diferença for uma regra de negócio no JavaScript (por exemplo, mostrar ou não o campo de preço duplo Espécie/Cartão no js/procedimentos.js), basta importar temFeature:

// JavaScript
// import { temFeature } from './configClinica.js';

// if (temFeature('precoDuploEspecieCartao')) {
//     // injeta o campo "Valor Cartão / Pix"
// }
export function aplicarWhiteLabelNaTela(cfg = {}) {
    clinicaState.configClinica = cfg;
    clinicaState.features = { ...FEATURES_PADRAO, ...(cfg.features || {}) };
    aplicarFeaturesNaTela();

    const nome = cfg.nomeFantasia || 'VITALIS - Clínicas';
    const subtitulo = cfg.subtitulo || 'Ambiente Operacional Seguro';
    const endereco = cfg.endereco || 'Endereço não configurado';
    const contato = [
        cfg.telefone ? `Contato: ${cfg.telefone}` : '',
        cfg.cnpj ? `CNPJ: ${cfg.cnpj}` : ''
    ].filter(Boolean).join(' | ');

    // 1. Atualiza Topbar e Sidebar do Sistema
    const elTitle = document.getElementById('page-title');
    const elSub = document.getElementById('page-subtitle');
    if (elTitle) elTitle.textContent = nome;
    if (elSub) elSub.textContent = subtitulo;

    // 2. Atualiza cor primária se a clínica personalizou
    if (cfg.corPrimaria) {
        document.documentElement.style.setProperty('--primary-color', cfg.corPrimaria);
    }

    // 3. Atualiza os Cabeçalhos de Impressão (Receituário A4 e Prontuário A5)
    document.querySelectorAll('.print-header-info').forEach((infoEl) => {
        infoEl.innerHTML = `
            <h2>${escapeHTML(nome)}</h2>
            <p>${escapeHTML(endereco)}</p>
            ${contato ? `<p>${escapeHTML(contato)}</p>` : ''}
        `;
    });

    document.querySelectorAll('.print-header-logo').forEach((logoEl) => {
        if (cfg.logoBase64) {
            logoEl.innerHTML = `<img src="${cfg.logoBase64}" alt="Logo" style="max-height:64px; max-width:160px; object-fit:contain;">`;
        } else {
            logoEl.innerHTML = `<i class="fa-solid fa-staff-snake"></i>`;
        }
    });
}

export async function carregarConfigClinica() {
    if (!clinicaState.sessao.clinicaId) return;
    try {
        const snap = await getDoc(doc(db, 'clinicas', clinicaState.sessao.clinicaId));
        if (snap.exists()) {
            const dados = snap.data();
            aplicarWhiteLabelNaTela(dados);
            preencherFormularioConfig(dados);
        }
    } catch (e) {
        console.error('Erro ao carregar configurações White-Label:', e);
    }
}

function preencherFormularioConfig(cfg = {}) {
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
    setVal('cfg-nome-fantasia', cfg.nomeFantasia);
    setVal('cfg-cnpj', cfg.cnpj);
    setVal('cfg-telefone', cfg.telefone);
    setVal('cfg-endereco', cfg.endereco);
    setVal('cfg-cor-primaria', cfg.corPrimaria || '#0F4C75');

    const preview = document.getElementById('cfg-logo-preview');
    if (preview) {
        preview.innerHTML = cfg.logoBase64
            ? `<img src="${cfg.logoBase64}" alt="Logo atual" style="max-height:70px; border-radius:8px;">`
            : `<small style="color:var(--text-light);">Nenhuma logo enviada (usando ícone padrão)</small>`;
    }
}

export function initConfigClinica() {
    const form = document.getElementById('form-config-clinica');
    const inputLogo = document.getElementById('cfg-logo-file');
    let novaLogoBase64 = null;

    inputLogo?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            novaLogoBase64 = await imagemParaBase64Comprimido(file, 360, 0.85);
            const preview = document.getElementById('cfg-logo-preview');
            if (preview) {
                preview.innerHTML = `<img src="${novaLogoBase64}" alt="Preview Logo" style="max-height:70px; border-radius:8px;">`;
            }
            showToast('Logo processada e otimizada em Base64!', 'info');
        } catch (err) {
            showToast('Erro ao processar imagem da logo.', 'error');
        }
    });

    form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (clinicaState.sessao.perfil !== 'admin') {
            return showToast('Apenas o Administrador pode alterar os dados da clínica.', 'error');
        }

        const btn = form.querySelector('button[type="submit"]');
        await comEstadoDeCarregamento(btn, 'Salvando...', async () => {
            const dadosAtuais = clinicaState.configClinica || {};
            const novosDados = {
                nomeFantasia: document.getElementById('cfg-nome-fantasia').value.trim(),
                cnpj: document.getElementById('cfg-cnpj').value.trim(),
                telefone: document.getElementById('cfg-telefone').value.trim(),
                endereco: document.getElementById('cfg-endereco').value.trim(),
                corPrimaria: document.getElementById('cfg-cor-primaria').value || '#0F4C75',
                logoBase64: novaLogoBase64 || dadosAtuais.logoBase64 || null,
                atualizadoEm: new Date().toISOString()
            };

            try {
                await setDoc(doc(db, 'clinicas', clinicaState.sessao.clinicaId), novosDados, { merge: true });
                aplicarWhiteLabelNaTela(novosDados);
                await registrarAuditoria({
                    acao: 'Edição',
                    modulo: 'Sistema',
                    descricao: `Identidade visual / dados da clínica atualizados (${novosDados.nomeFantasia})`
                });
                showToast('Dados da clínica e receituários atualizados com sucesso!', 'success');
            } catch (err) {
                console.error('Erro ao salvar config da clínica:', err);
                showToast('Permissão negada ou falha ao salvar. Verifique o firestore.rules.', 'error');
            }
        });
    });
}