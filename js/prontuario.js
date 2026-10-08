import { clinicaState } from './state.js';
import { showToast, escapeHTML, encriptar, decriptar, comEstadoDeCarregamento, confirmarAcao } from './Ferramentas.js';
import { db } from './firebase.js';
import { doc, updateDoc } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { registrarAuditoria } from './auditoria.js';

// ========================================================
// PRONTUÁRIO ELETRÔNICO (PEP) - estrutura clínica
// Este módulo concentra tudo o que o prontuário tem além do básico de
// cadastro/assinatura que já mora em pacientes.js:
//
//  - Sinais vitais e antropometria (PA, FC, FR, Temp, SpO2, peso,
//    altura, IMC, glicemia), com validação e destaque de valores fora
//    da faixa usual de adulto
//  - Antecedentes pessoais/familiares (anamnese permanente do paciente)
//  - Faixa de alertas clínicos sempre visível (alergias, comorbidades,
//    medicamentos de uso contínuo)
//  - Visão geral do paciente (aba Resumo) com tendência dos sinais vitais
//  - CID-10 com sugestões (lista curta dos mais comuns; aceita texto livre)
//  - Rascunho automático da evolução em andamento (criptografado, só na
//    sessão da aba - some ao fechar o navegador)
//  - Registro de ACESSO ao prontuário na Auditoria (rastreabilidade/LGPD)
//  - Impressão do prontuário completo
//
// pacientes.js só chama as funções exportadas aqui (ganchos); este arquivo
// NÃO importa pacientes.js, para não criar dependência circular.
// ========================================================

let pacienteAtual = null;
let temporizadorRascunho = null;
const ultimoAcessoRegistrado = new Map();

// ---------- utilidades ----------
const el = (id) => document.getElementById(id);

function normalizar(txt) {
    return String(txt || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function dividirLista(txt) {
    return String(txt || '')
        .split(/\n|;/)
        .map(s => s.trim())
        .filter(Boolean);
}

function formatarDataISO(iso) {
    if (!iso) return '-';
    const partes = String(iso).split('-');
    return partes.length === 3 ? partes.reverse().join('/') : iso;
}

export function idadeEmAnos(nascimentoISO) {
    if (!nascimentoISO) return null;
    const [a, m, d] = String(nascimentoISO).split('-').map(Number);
    if (!a || !m || !d) return null;
    const hoje = new Date();
    let anos = hoje.getFullYear() - a;
    if (hoje.getMonth() + 1 < m || (hoje.getMonth() + 1 === m && hoje.getDate() < d)) anos--;
    return anos >= 0 ? anos : null;
}

// "34 anos" ou, para menores de 2 anos, "9 meses"
export function calcularIdade(nascimentoISO) {
    const anos = idadeEmAnos(nascimentoISO);
    if (anos === null) return '';
    if (anos >= 2) return `${anos} anos`;
    const [a, m, d] = String(nascimentoISO).split('-').map(Number);
    const hoje = new Date();
    let meses = (hoje.getFullYear() - a) * 12 + (hoje.getMonth() + 1 - m);
    if (hoje.getDate() < d) meses--;
    return `${Math.max(meses, 0)} ${meses === 1 ? 'mês' : 'meses'}`;
}

// Mesmo critério de pacientes.js: pega o valor de um campo "**Rótulo:** valor"
// dentro do texto da evolução.
export function extrairCampo(texto, rotulos) {
    const re = new RegExp('\\*\\*(?:' + rotulos.join('|') + ')[^*]*:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\s*\\*\\*|$)', 'i');
    const m = String(texto || '').match(re);
    const valor = m ? m[1].trim() : '';
    return valor && valor !== 'N/A' ? valor : '';
}

function formatarTextoEvolucao(texto) {
    return escapeHTML(String(texto || ''))
        .replace(/\n/g, '<br>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
}

// ========================================================
// SINAIS VITAIS
// ========================================================
const SINAIS = [
    { k: 'paSis', id: 'pep-sv-pa-sis', rotulo: 'PA sistólica', min: 40, max: 300 },
    { k: 'paDia', id: 'pep-sv-pa-dia', rotulo: 'PA diastólica', min: 20, max: 200 },
    { k: 'fc', id: 'pep-sv-fc', rotulo: 'Frequência cardíaca', min: 20, max: 300 },
    { k: 'fr', id: 'pep-sv-fr', rotulo: 'Frequência respiratória', min: 4, max: 80 },
    { k: 'temp', id: 'pep-sv-temp', rotulo: 'Temperatura', min: 30, max: 45 },
    { k: 'spo2', id: 'pep-sv-spo2', rotulo: 'Saturação de O2', min: 40, max: 100 },
    { k: 'peso', id: 'pep-sv-peso', rotulo: 'Peso', min: 0.3, max: 500 },
    { k: 'altura', id: 'pep-sv-altura', rotulo: 'Altura', min: 20, max: 250 },
    { k: 'glicemia', id: 'pep-sv-glicemia', rotulo: 'Glicemia', min: 10, max: 1000 }
];

function lerNumero(id) {
    const campo = el(id);
    if (!campo) return null;
    const bruto = String(campo.value || '').replace(',', '.').trim();
    if (!bruto) return null;
    const n = Number(bruto);
    return Number.isFinite(n) ? n : NaN;
}

function calcularIMC(peso, altura) {
    if (!peso || !altura || Number.isNaN(peso) || Number.isNaN(altura)) return null;
    const m = altura / 100;
    return Math.round((peso / (m * m)) * 10) / 10;
}

function classificarIMC(imc) {
    if (imc === null) return '';
    if (imc < 18.5) return 'Abaixo do peso';
    if (imc < 25) return 'Peso normal';
    if (imc < 30) return 'Sobrepeso';
    if (imc < 35) return 'Obesidade grau I';
    if (imc < 40) return 'Obesidade grau II';
    return 'Obesidade grau III';
}

// Retorna null se nenhum sinal vital foi preenchido
export function lerSinaisVitais() {
    const v = {};
    let algum = false;
    SINAIS.forEach(s => {
        const n = lerNumero(s.id);
        if (n !== null && !Number.isNaN(n)) {
            v[s.k] = n;
            algum = true;
        }
    });
    if (!algum) return null;
    const imc = calcularIMC(v.peso, v.altura);
    if (imc !== null) v.imc = imc;
    return v;
}

// Devolve a mensagem do primeiro problema encontrado ('' se tudo certo)
export function validarSinaisVitais() {
    for (const s of SINAIS) {
        const n = lerNumero(s.id);
        if (n === null) continue;
        if (Number.isNaN(n)) return `${s.rotulo}: informe apenas números.`;
        if (n < s.min || n > s.max) return `${s.rotulo} fora do intervalo possível (${s.min} a ${s.max}). Confira o valor digitado.`;
    }
    const sis = lerNumero('pep-sv-pa-sis');
    const dia = lerNumero('pep-sv-pa-dia');
    if ((sis !== null) !== (dia !== null)) return 'Informe a pressão arterial completa (sistólica e diastólica).';
    if (sis !== null && dia !== null && sis <= dia) return 'A pressão sistólica deve ser maior que a diastólica.';
    return '';
}

export function formatarSinaisVitais(v) {
    if (!v) return '';
    const partes = [];
    if (v.paSis !== undefined && v.paDia !== undefined) partes.push(`PA ${v.paSis}/${v.paDia} mmHg`);
    if (v.fc !== undefined) partes.push(`FC ${v.fc} bpm`);
    if (v.fr !== undefined) partes.push(`FR ${v.fr} irpm`);
    if (v.temp !== undefined) partes.push(`Tax ${v.temp} °C`);
    if (v.spo2 !== undefined) partes.push(`SpO2 ${v.spo2}%`);
    if (v.peso !== undefined) partes.push(`Peso ${v.peso} kg`);
    if (v.altura !== undefined) partes.push(`Altura ${v.altura} cm`);
    if (v.imc !== undefined) partes.push(`IMC ${v.imc} kg/m²`);
    if (v.glicemia !== undefined) partes.push(`Glicemia capilar ${v.glicemia} mg/dL`);
    return partes.join(' | ');
}

// Marca em amarelo os campos fora da faixa usual DE ADULTO (só para
// pacientes com 18+ anos; em crianças as faixas mudam por idade, então
// o sistema não sinaliza nada para não induzir a erro).
function atualizarAlertasSinaisVitais() {
    const imcCampo = el('pep-sv-imc');
    const imc = calcularIMC(lerNumero('pep-sv-peso'), lerNumero('pep-sv-altura'));
    if (imcCampo) {
        imcCampo.value = imc !== null ? `${imc} (${classificarIMC(imc)})` : '';
    }

    const idade = pacienteAtual ? idadeEmAnos(pacienteAtual.nascimento) : null;
    const adulto = idade !== null && idade >= 18;

    const regras = {
        'pep-sv-pa-sis': (n) => n >= 140 || n < 90,
        'pep-sv-pa-dia': (n) => n >= 90 || n < 60,
        'pep-sv-fc': (n) => n < 50 || n > 100,
        'pep-sv-fr': (n) => n < 12 || n > 20,
        'pep-sv-temp': (n) => n >= 37.8 || n < 35.5,
        'pep-sv-spo2': (n) => n < 92,
        'pep-sv-glicemia': (n) => n < 70 || n > 180
    };

    Object.entries(regras).forEach(([id, foraDaFaixa]) => {
        const campo = el(id);
        if (!campo) return;
        const n = lerNumero(id);
        const alerta = adulto && n !== null && !Number.isNaN(n) && foraDaFaixa(n);
        campo.classList.toggle('sv-alerta', alerta);
        campo.title = alerta ? 'Fora da faixa usual de adulto - confira a medição.' : '';
    });
}

// ========================================================
// TEXTO DA EVOLUÇÃO (formato "**Rótulo:** valor", compatível com o
// que o resumo/histórico/impressão já sabem ler)
// ========================================================
export function montarTextoEvolucao() {
    const valor = (id) => (el(id)?.value || '').trim();
    const sv = formatarSinaisVitais(lerSinaisVitais());
    const cid = valor('pep-cid');
    const hipotese = valor('pep-diagnostico');
    const hipoteseFinal = [hipotese, cid ? `(CID-10: ${cid})` : ''].filter(Boolean).join(' ') || 'N/A';

    const linhas = [
        `**Queixa Principal:** ${valor('pep-queixa')}`,
        `**HDA / Anamnese:** ${valor('pep-anamnese')}`
    ];
    if (sv) linhas.push(`**Sinais Vitais:** ${sv}`);
    linhas.push(
        `**Exame Físico:** ${valor('pep-exame-fisico')}`,
        `**Hipótese Diagnóstica:** ${hipoteseFinal}`,
        `**Conduta e Prescrição:** ${valor('pep-prescricao')}`
    );
    return linhas.join('\n');
}

// ========================================================
// ANTECEDENTES (anamnese permanente do paciente)
// Guardados criptografados em paciente.antecedentesCripto (JSON).
// ========================================================
const CAMPOS_ANTECEDENTES = {
    comorbidades: 'pep-ant-comorbidades',
    medicamentos: 'pep-ant-medicamentos',
    alergias: 'pep-ant-alergias',
    cirurgias: 'pep-ant-cirurgias',
    familiar: 'pep-ant-familiar',
    habitos: 'pep-ant-habitos',
    gineco: 'pep-ant-gineco',
    observacoes: 'pep-ant-obs'
};

function lerAntecedentes(paciente) {
    if (!paciente || !paciente.antecedentesCripto) return {};
    try {
        const obj = JSON.parse(decriptar(paciente.antecedentesCripto));
        return obj && typeof obj === 'object' ? obj : {};
    } catch (e) {
        return {};
    }
}

function preencherFormularioAntecedentes(paciente) {
    const ant = lerAntecedentes(paciente);
    Object.entries(CAMPOS_ANTECEDENTES).forEach(([chave, id]) => {
        const campo = el(id);
        if (campo) campo.value = ant[chave] || '';
    });

    const info = el('pep-ant-atualizacao');
    if (info) {
        if (paciente.antecedentesAtualizadoEm) {
            const quando = new Date(paciente.antecedentesAtualizadoEm).toLocaleString('pt-BR');
            info.textContent = `Última atualização: ${quando}${paciente.antecedentesPor ? ' por ' + paciente.antecedentesPor : ''}`;
        } else {
            info.textContent = 'Ainda não preenchido.';
        }
    }
}

function chips(lista, classe = '') {
    return lista.map(t => `<span class="alerta-chip ${classe}">${escapeHTML(t)}</span>`).join('');
}

function renderizarAlertasClinicos(paciente) {
    const caixa = el('pep-alerta-clinico');
    if (!caixa || !paciente) return;

    const ant = lerAntecedentes(paciente);

    // Alergias: junta o que veio do cadastro (recepção) com o que o médico
    // registrou nos antecedentes, sem repetir
    const vistos = new Set();
    const alergias = [...String(paciente.alergias || '').split(/,|;|\n/), ...dividirLista(ant.alergias)]
        .map(s => s.trim())
        .filter(s => {
            const k = normalizar(s);
            if (!k || vistos.has(k)) return false;
            vistos.add(k);
            return true;
        });

    const comorbidades = dividirLista(ant.comorbidades);
    const medicamentos = dividirLista(ant.medicamentos);

    const grupoAlergia = alergias.length
        ? `<div class="alerta-grupo danger"><span class="alerta-rotulo"><i class="fa-solid fa-triangle-exclamation"></i> Alergias</span>${chips(alergias, 'danger')}</div>`
        : `<div class="alerta-grupo"><span class="alerta-vazio"><i class="fa-solid fa-check"></i> Sem alergias registradas</span></div>`;

    caixa.innerHTML = grupoAlergia +
        (comorbidades.length ? `<div class="alerta-grupo"><span class="alerta-rotulo"><i class="fa-solid fa-heart-pulse"></i> Comorbidades</span>${chips(comorbidades)}</div>` : '') +
        (medicamentos.length ? `<div class="alerta-grupo"><span class="alerta-rotulo"><i class="fa-solid fa-pills"></i> Uso contínuo</span>${chips(medicamentos)}</div>` : '');
}

function iniciarFormularioAntecedentes() {
    const form = el('form-antecedentes');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!pacienteAtual) return;
        const paciente = pacienteAtual;
        const btn = form.querySelector('button[type="submit"]');

        await comEstadoDeCarregamento(btn, 'Salvando...', async () => {
            const dados = {};
            Object.entries(CAMPOS_ANTECEDENTES).forEach(([chave, id]) => {
                dados[chave] = (el(id)?.value || '').trim();
            });

            const anterior = {
                antecedentesCripto: paciente.antecedentesCripto,
                antecedentesAtualizadoEm: paciente.antecedentesAtualizadoEm,
                antecedentesPor: paciente.antecedentesPor
            };

            const novo = {
                antecedentesCripto: encriptar(JSON.stringify(dados)),
                antecedentesAtualizadoEm: new Date().toISOString(),
                antecedentesPor: clinicaState.sessao.nome || ''
            };

            Object.assign(paciente, novo);

            try {
                await updateDoc(doc(db, 'pacientes', paciente.id), novo);
                showToast('Antecedentes atualizados com sucesso.', 'success');
                await registrarAuditoria({ acao: 'Edição', modulo: 'Prontuário', descricao: `Antecedentes atualizados: ${paciente.nome}` });
                preencherFormularioAntecedentes(paciente);
                renderizarAlertasClinicos(paciente);
                renderizarVisaoGeral(paciente);
            } catch (error) {
                console.error('Erro ao salvar antecedentes: ', error);
                Object.assign(paciente, anterior);
                showToast('Erro de conexão ao salvar os antecedentes.', 'error');
            }
        });
    });
}

// ========================================================
// VISÃO GERAL (aba Resumo)
// ========================================================
function lerVitaisDaEvolucao(evo) {
    if (!evo || !evo.vitaisCripto) return null;
    try {
        return JSON.parse(decriptar(evo.vitaisCripto));
    } catch (e) {
        return null;
    }
}

function renderizarVisaoGeral(paciente) {
    const container = el('pep-visao-geral');
    if (!container || !paciente) return;

    const evolucoes = paciente.evolucoes || [];
    const ultima = evolucoes[evolucoes.length - 1];
    const primeira = evolucoes[0];
    const ant = lerAntecedentes(paciente);

    let hipotese = '';
    let conduta = '';
    if (ultima) {
        const texto = decriptar(ultima.texto);
        hipotese = extrairCampo(texto, ['Hipótese Diagnóstica', 'Suspeita Diagnóstica', 'Suposto Diagnóstico', 'Diagnóstico']);
        conduta = extrairCampo(texto, ['Conduta']);
    }

    const dataCurta = (evo) => (evo && evo.data ? String(evo.data).split(',')[0] : '-');
    const exames = (paciente.examesSolicitados || []).length;

    const cartoes = `
        <div class="pep-visao-cards">
            <div class="pep-visao-card"><span class="rotulo">Atendimentos</span><strong>${evolucoes.length}</strong></div>
            <div class="pep-visao-card"><span class="rotulo">Primeiro atendimento</span><strong>${escapeHTML(dataCurta(primeira))}</strong></div>
            <div class="pep-visao-card"><span class="rotulo">Último atendimento</span><strong>${escapeHTML(dataCurta(ultima))}</strong></div>
            <div class="pep-visao-card"><span class="rotulo">Retorno previsto</span><strong>${escapeHTML(paciente.proximoRetorno ? formatarDataISO(paciente.proximoRetorno) : 'Não definido')}</strong></div>
            <div class="pep-visao-card"><span class="rotulo">Exames solicitados</span><strong>${exames}</strong></div>
        </div>`;

    const ultimoQuadro = ultima
        ? `<div class="pep-bloco-linha"><span class="rotulo">Última hipótese diagnóstica</span><p>${escapeHTML(hipotese || 'Não informada')}</p></div>
           <div class="pep-bloco-linha"><span class="rotulo">Última conduta</span><p>${escapeHTML(conduta || 'Não informada')}</p></div>`
        : '<p class="resumo-rapido-vazio">Paciente ainda sem atendimentos registrados. Use a aba Atendimento para iniciar o prontuário.</p>';

    // Tendência dos últimos sinais vitais (mais recente primeiro)
    const medicoes = evolucoes
        .map(e => ({ data: dataCurta(e), v: lerVitaisDaEvolucao(e) }))
        .filter(m => m.v)
        .slice(-5)
        .reverse();

    const tabelaVitais = medicoes.length
        ? `<div class="table-container"><table class="data-table pep-tabela-vitais">
            <thead><tr><th>Data</th><th>PA</th><th>FC</th><th>Temp</th><th>SpO2</th><th>Peso</th><th>IMC</th></tr></thead>
            <tbody>${medicoes.map(m => `<tr>
                <td>${escapeHTML(m.data)}</td>
                <td>${m.v.paSis !== undefined && m.v.paDia !== undefined ? `${m.v.paSis}/${m.v.paDia}` : '-'}</td>
                <td>${m.v.fc ?? '-'}</td>
                <td>${m.v.temp ?? '-'}</td>
                <td>${m.v.spo2 !== undefined ? m.v.spo2 + '%' : '-'}</td>
                <td>${m.v.peso !== undefined ? m.v.peso + ' kg' : '-'}</td>
                <td>${m.v.imc ?? '-'}</td>
            </tr>`).join('')}</tbody></table></div>`
        : '<p class="resumo-rapido-vazio">Nenhum sinal vital registrado ainda.</p>';

    const listaAnt = (titulo, texto) => {
        const itens = dividirLista(texto);
        return itens.length
            ? `<div class="pep-bloco-linha"><span class="rotulo">${titulo}</span><p>${itens.map(escapeHTML).join(' &bull; ')}</p></div>`
            : '';
    };
    const antecedentesResumo = [
        listaAnt('Cirurgias / internações', ant.cirurgias),
        listaAnt('Histórico familiar', ant.familiar),
        listaAnt('Hábitos', ant.habitos)
    ].join('') || '<p class="resumo-rapido-vazio">Antecedentes ainda não preenchidos (aba Antecedentes).</p>';

    container.innerHTML = `
        ${cartoes}
        <div class="pep-visao-colunas">
            <div class="pep-bloco"><h4><i class="fa-solid fa-stethoscope"></i> Último quadro clínico</h4>${ultimoQuadro}</div>
            <div class="pep-bloco"><h4><i class="fa-solid fa-book-medical"></i> Antecedentes</h4>${antecedentesResumo}</div>
        </div>
        <div class="pep-bloco"><h4><i class="fa-solid fa-heart-pulse"></i> Últimos sinais vitais</h4>${tabelaVitais}</div>`;
}

// ========================================================
// RASCUNHO AUTOMÁTICO DA EVOLUÇÃO
// ========================================================
const CAMPOS_RASCUNHO = [
    'pep-queixa', 'pep-anamnese',
    ...SINAIS.map(s => s.id),
    'pep-exame-fisico', 'pep-cid', 'pep-diagnostico', 'pep-prescricao', 'pep-retorno-dias'
];

function chaveRascunho(paciente) {
    return `pep_rascunho_${clinicaState.sessao.clinicaId}_${paciente.id}`;
}

function atualizarStatusRascunho(texto) {
    const s = el('pep-rascunho-status');
    if (s) s.textContent = texto;
}

function salvarRascunho() {
    if (!pacienteAtual) return;
    const dados = {};
    let algum = false;
    CAMPOS_RASCUNHO.forEach(id => {
        const campo = el(id);
        if (campo && campo.value) {
            dados[id] = campo.value;
            algum = true;
        }
    });

    try {
        if (algum) {
            sessionStorage.setItem(chaveRascunho(pacienteAtual), encriptar(JSON.stringify(dados)));
            const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            atualizarStatusRascunho(`Rascunho salvo automaticamente às ${hora}`);
        } else {
            sessionStorage.removeItem(chaveRascunho(pacienteAtual));
            atualizarStatusRascunho('');
        }
    } catch (e) {
        // sessionStorage indisponível: o rascunho é só uma conveniência
    }
}

function restaurarRascunho(paciente) {
    try {
        const bruto = sessionStorage.getItem(chaveRascunho(paciente));
        if (!bruto) return;
        const dados = JSON.parse(decriptar(bruto));
        let restaurou = false;
        Object.entries(dados).forEach(([id, valor]) => {
            const campo = el(id);
            if (campo && CAMPOS_RASCUNHO.includes(id)) {
                campo.value = valor;
                restaurou = true;
            }
        });
        if (restaurou) {
            atualizarAlertasSinaisVitais();
            atualizarStatusRascunho('Rascunho anterior restaurado');
            showToast('Rascunho da evolução restaurado.', 'warning');
        }
    } catch (e) {
        // rascunho corrompido: ignora
    }
}

function limparRascunho(paciente) {
    try {
        sessionStorage.removeItem(chaveRascunho(paciente));
    } catch (e) { /* ignora */ }
    atualizarStatusRascunho('');
}

// ========================================================
// CID-10 (sugestões das hipóteses mais comuns; o campo aceita qualquer
// código ou texto digitado - a lista só agiliza o dia a dia)
// ========================================================
const CID_COMUNS = [
    ['A09', 'Diarreia e gastroenterite de origem infecciosa presumível'],
    ['A90', 'Dengue [dengue clássico]'],
    ['B34.9', 'Infecção viral não especificada'],
    ['D64.9', 'Anemia não especificada'],
    ['E03.9', 'Hipotireoidismo não especificado'],
    ['E11.9', 'Diabetes mellitus tipo 2 sem complicações'],
    ['E55.9', 'Deficiência de vitamina D não especificada'],
    ['E66.9', 'Obesidade não especificada'],
    ['E78.5', 'Hiperlipidemia não especificada'],
    ['F32.9', 'Episódio depressivo não especificado'],
    ['F41.1', 'Ansiedade generalizada'],
    ['F41.9', 'Transtorno ansioso não especificado'],
    ['F43.2', 'Transtornos de adaptação'],
    ['F84.0', 'Autismo infantil'],
    ['F90.0', 'Perturbação da atividade e da atenção'],
    ['G43.9', 'Enxaqueca não especificada'],
    ['G44.2', 'Cefaleia tensional'],
    ['G47.0', 'Insônia'],
    ['H10.9', 'Conjuntivite não especificada'],
    ['H66.9', 'Otite média não especificada'],
    ['I10', 'Hipertensão essencial (primária)'],
    ['I25.9', 'Doença isquêmica crônica do coração não especificada'],
    ['I50.9', 'Insuficiência cardíaca não especificada'],
    ['J00', 'Nasofaringite aguda (resfriado comum)'],
    ['J01.9', 'Sinusite aguda não especificada'],
    ['J02.9', 'Faringite aguda não especificada'],
    ['J03.9', 'Amigdalite aguda não especificada'],
    ['J06.9', 'Infecção aguda das vias aéreas superiores não especificada'],
    ['J18.9', 'Pneumonia não especificada'],
    ['J20.9', 'Bronquite aguda não especificada'],
    ['J30.4', 'Rinite alérgica não especificada'],
    ['J45.9', 'Asma não especificada'],
    ['K21.9', 'Doença de refluxo gastroesofágico sem esofagite'],
    ['K29.7', 'Gastrite não especificada'],
    ['K30', 'Dispepsia'],
    ['K59.0', 'Constipação'],
    ['L20.9', 'Dermatite atópica não especificada'],
    ['L30.9', 'Dermatite não especificada'],
    ['L50.9', 'Urticária não especificada'],
    ['M19.9', 'Artrose não especificada'],
    ['M25.5', 'Dor articular'],
    ['M54.2', 'Cervicalgia'],
    ['M54.5', 'Dor lombar baixa'],
    ['M79.1', 'Mialgia'],
    ['N30.0', 'Cistite aguda'],
    ['N39.0', 'Infecção do trato urinário de localização não especificada'],
    ['R05', 'Tosse'],
    ['R07.4', 'Dor torácica não especificada'],
    ['R10.4', 'Outras dores abdominais e as não especificadas'],
    ['R11', 'Náusea e vômitos'],
    ['R42', 'Tontura e instabilidade'],
    ['R50.9', 'Febre não especificada'],
    ['R51', 'Cefaleia'],
    ['R53', 'Mal estar e fadiga'],
    ['T78.4', 'Alergia não especificada'],
    ['U07.1', 'COVID-19, vírus identificado'],
    ['Z00.0', 'Exame médico geral'],
    ['Z76.0', 'Emissão de prescrição de repetição']
];

function preencherListaCID() {
    const lista = el('lista-cid10');
    if (!lista || lista.children.length) return;
    lista.innerHTML = CID_COMUNS
        .map(([cod, desc]) => `<option value="${escapeHTML(cod)}">${escapeHTML(desc)}</option>`)
        .join('');
}

// ========================================================
// IMPRESSÃO DO PRONTUÁRIO COMPLETO
// ========================================================
function imprimirProntuarioCompleto() {
    if (!pacienteAtual) return;
    const paciente = pacienteAtual;
    const evolucoes = paciente.evolucoes || [];

    const dataNasc = paciente.nascimento ? formatarDataISO(paciente.nascimento) : 'Não inf.';
    el('print-pep-nome').textContent = paciente.nome;
    el('print-pep-dados').textContent = `CPF: ${paciente.cpf || 'Não inf.'} | Nasc: ${dataNasc} | Tel: ${paciente.telefone || 'Não inf.'}`;
    el('print-pep-convenio').textContent = paciente.convenio || 'Particular';
    el('print-pep-alergias').textContent = paciente.alergias || 'Nenhuma alergia registrada';
    el('print-pep-data').textContent = new Date().toLocaleDateString('pt-BR');

    const ant = lerAntecedentes(paciente);
    const linhasAnt = [
        ['Comorbidades', ant.comorbidades], ['Uso contínuo', ant.medicamentos], ['Alergias (clínico)', ant.alergias],
        ['Cirurgias/internações', ant.cirurgias], ['Histórico familiar', ant.familiar], ['Hábitos', ant.habitos],
        ['Gineco-obstétrico', ant.gineco], ['Observações', ant.observacoes]
    ].filter(([, v]) => v && String(v).trim());

    const blocoAnt = linhasAnt.length
        ? `<div class="print-evo"><p><strong>ANTECEDENTES</strong></p>${linhasAnt.map(([r, v]) => `<p><strong>${r}:</strong> ${escapeHTML(v).replace(/\n/g, '; ')}</p>`).join('')}</div><hr>`
        : '';

    const blocoEvo = evolucoes.length
        ? evolucoes.map(evo => `
            <div class="print-evo">
                <p><strong>${escapeHTML(evo.data || '')}</strong> &mdash; <em>${escapeHTML(evo.assinatura || '')}</em></p>
                <div>${formatarTextoEvolucao(decriptar(evo.texto))}</div>
            </div><hr>`).join('')
        : 'Sem evoluções registradas ainda.';

    el('print-pep-conteudo').innerHTML = blocoAnt + blocoEvo;
    el('print-pep-assinatura').textContent = `Prontuário impresso em ${new Date().toLocaleString('pt-BR')} por ${clinicaState.sessao.nome || ''}`;

    const titulo = document.querySelector('#print-area-pep .print-doc-title');
    const tituloOriginal = titulo ? titulo.textContent : '';
    if (titulo) titulo.textContent = 'PRONTUÁRIO - HISTÓRICO COMPLETO';
    window.addEventListener('afterprint', () => {
        if (titulo) titulo.textContent = tituloOriginal;
    }, { once: true });

    registrarAuditoria({ acao: 'Acesso', modulo: 'Prontuário', descricao: `Impressão do prontuário completo: ${paciente.nome}` });

    document.body.setAttribute('data-impressao', 'pep');
    window.print();
}

// ========================================================
// DOCUMENTOS: texto-modelo e orientação por tipo
// ========================================================
const DICAS_DOCUMENTO = {
    'ATESTADO MÉDICO': 'Atenção: pela Resolução CFM nº 1.658/2002, o diagnóstico (CID) só pode constar no atestado com autorização expressa do paciente.'
};

let ultimoModeloAutomatico = '';

function modeloDocumento(tipo, paciente) {
    const nome = paciente ? paciente.nome : '[paciente]';
    const hoje = new Date().toLocaleDateString('pt-BR');
    if (tipo === 'ATESTADO MÉDICO') {
        return `Atesto, para os devidos fins, que o(a) paciente ${nome} foi atendido(a) nesta data (${hoje}), necessitando de ___ dia(s) de afastamento de suas atividades, a partir de ${hoje}.`;
    }
    if (tipo === 'RELATÓRIO MÉDICO') {
        return `Relatório referente ao(à) paciente ${nome}, em acompanhamento nesta clínica.\n\nQuadro clínico: \n\nConduta adotada: \n\nPrognóstico / observações: `;
    }
    return '';
}

function iniciarDocumentos() {
    const tipo = el('tipo-documento-impressao');
    const texto = el('texto-receita');
    const dica = el('doc-dica');
    if (!tipo || !texto) return;

    tipo.addEventListener('change', () => {
        if (dica) {
            const msg = DICAS_DOCUMENTO[tipo.value] || '';
            dica.textContent = msg;
            dica.style.display = msg ? 'block' : 'none';
        }
        // Só preenche o modelo se o campo estiver vazio ou ainda tiver o
        // modelo automático anterior (nunca sobrescreve texto do médico)
        const vazioOuAuto = !texto.value.trim() || texto.value === ultimoModeloAutomatico;
        const modelo = modeloDocumento(tipo.value, pacienteAtual);
        if (vazioOuAuto && modelo) {
            texto.value = modelo;
            ultimoModeloAutomatico = modelo;
        } else if (vazioOuAuto) {
            texto.value = '';
            ultimoModeloAutomatico = '';
        }
    });
}

// ========================================================
// NAVEGAÇÃO ENTRE ABAS (usada pelos ganchos e pelos atalhos)
// ========================================================
export function irParaAba(idAba) {
    const btn = document.querySelector(`.tab-btn[data-tab="${idAba}"]`);
    const alvo = el(idAba);
    if (!btn || !alvo) return;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    alvo.classList.add('active');
}

// ========================================================
// GANCHOS CHAMADOS POR pacientes.js
// ========================================================
export function initProntuarioExtras() {
    preencherListaCID();
    iniciarFormularioAntecedentes();
    iniciarDocumentos();

    // Sinais vitais: IMC e destaque de valores fora da faixa
    SINAIS.forEach(s => {
        el(s.id)?.addEventListener('input', atualizarAlertasSinaisVitais);
    });

    // Rascunho automático (espera o médico parar de digitar)
    el('form-evolucao')?.addEventListener('input', () => {
        clearTimeout(temporizadorRascunho);
        temporizadorRascunho = setTimeout(salvarRascunho, 800);
    });

    // Atalhos de retorno (7, 15, 30 dias...)
    document.querySelectorAll('.chip-retorno').forEach(chip => {
        chip.addEventListener('click', () => {
            const campo = el('pep-retorno-dias');
            if (campo) {
                campo.value = chip.dataset.dias;
                campo.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
    });

    // Copiar a conduta da última consulta (útil em retornos)
    el('btn-copiar-ultima-conduta')?.addEventListener('click', async () => {
        if (!pacienteAtual) return;
        const evolucoes = pacienteAtual.evolucoes || [];
        const ultima = evolucoes[evolucoes.length - 1];
        const conduta = ultima ? extrairCampo(decriptar(ultima.texto), ['Conduta']) : '';
        if (!conduta) {
            showToast('Não há conduta anterior registrada para copiar.', 'warning');
            return;
        }
        const campo = el('pep-prescricao');
        if (campo.value.trim() && !(await confirmarAcao('Substituir o texto atual de Conduta pela conduta da última consulta?', { titulo: 'Copiar conduta anterior', textoConfirmar: 'Substituir', perigoso: false }))) return;
        campo.value = conduta;
        campo.dispatchEvent(new Event('input', { bubbles: true }));
        showToast('Conduta da última consulta copiada. Revise antes de assinar.', 'success');
    });

    // Levar a conduta para o gerador de documentos (receituário)
    el('btn-conduta-para-receita')?.addEventListener('click', () => {
        const conduta = (el('pep-prescricao')?.value || '').trim();
        if (!conduta) {
            showToast('Preencha a Conduta e Prescrição primeiro.', 'warning');
            return;
        }
        const tipo = el('tipo-documento-impressao');
        if (tipo) tipo.value = 'RECEITUÁRIO MÉDICO';
        const texto = el('texto-receita');
        if (texto) texto.value = conduta;
        ultimoModeloAutomatico = '';
        irParaAba('tab-receita');
        showToast('Conduta enviada para o receituário. Revise e imprima.', 'success');
    });

    // Atalho da aba Resumo
    el('btn-iniciar-atendimento')?.addEventListener('click', () => irParaAba('tab-evolucao'));

    // Busca dentro do histórico clínico
    const busca = el('pep-busca-historico');
    if (busca) {
        busca.addEventListener('input', () => {
            const termo = normalizar(busca.value.trim());
            document.querySelectorAll('#pep-timeline .timeline-item').forEach(item => {
                const bate = !termo || normalizar(item.textContent).includes(termo);
                item.style.display = bate ? '' : 'none';
                item.open = Boolean(termo) && bate;
            });
        });
    }

    el('btn-imprimir-pep-completo')?.addEventListener('click', imprimirProntuarioCompleto);
}

// aba: id da aba a abrir ('tab-evolucao' quando vem do botão "Atender" da fila)
export function aoAbrirProntuario(paciente, aba) {
    pacienteAtual = paciente;
    preencherListaCID();

    // Limpa qualquer texto deixado pelo paciente anterior (segurança clínica),
    // preservando o profissional que assina
    const selProf = el('pep-profissional');
    const profAtual = selProf ? selProf.value : '';
    el('form-evolucao')?.reset();
    if (selProf) selProf.value = profAtual;
    const busca = el('pep-busca-historico');
    if (busca) busca.value = '';
    const textoDoc = el('texto-receita');
    if (textoDoc) textoDoc.value = '';
    ultimoModeloAutomatico = '';
    const dica = el('doc-dica');
    if (dica) dica.style.display = 'none';

    renderizarAlertasClinicos(paciente);
    preencherFormularioAntecedentes(paciente);
    renderizarVisaoGeral(paciente);
    atualizarAlertasSinaisVitais();
    restaurarRascunho(paciente);

    const semAtendimentos = !(paciente.evolucoes && paciente.evolucoes.length);
    irParaAba(aba || (semAtendimentos ? 'tab-evolucao' : 'tab-resumo'));

    // Rastreabilidade de acesso (LGPD / CFM): quem abriu qual prontuário.
    // Evita registrar de novo se o mesmo prontuário foi aberto há menos de 30s.
    const agora = Date.now();
    const ultimo = ultimoAcessoRegistrado.get(paciente.id) || 0;
    if (agora - ultimo > 30000) {
        ultimoAcessoRegistrado.set(paciente.id, agora);
        registrarAuditoria({ acao: 'Acesso', modulo: 'Prontuário', descricao: `Prontuário aberto: ${paciente.nome}` });
    }
}

export function aoFecharProntuario() {
    clearTimeout(temporizadorRascunho);
    if (pacienteAtual) salvarRascunho();
    pacienteAtual = null;
}

export function aoSalvarEvolucao(paciente) {
    clearTimeout(temporizadorRascunho);
    limparRascunho(paciente);
    atualizarAlertasSinaisVitais();
    renderizarVisaoGeral(paciente);
    const busca = el('pep-busca-historico');
    if (busca) busca.value = '';
}