import { clinicaState } from './state.js';
import { showToast, confirmarAcao } from './Ferramentas.js';
import { db } from './firebase.js';
import { doc, getDoc, updateDoc, deleteField, Timestamp } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { registrarAuditoria } from './auditoria.js';

// ========================================================
// CRONÔMETRO DE ATENDIMENTO + TRAVA "EM ATENDIMENTO"
// Pedido do Dr. Aroldo: ver quanto tempo o atendimento está levando e
// evitar que a recepção mexa no cadastro do paciente enquanto, por
// exemplo, a T.O. está há 45 minutos atendendo.
//
// COMO FUNCIONA
//  - "Iniciar atendimento" grava no documento do paciente:
//      atendimentoEmAndamento { inicioISO, porNome, porEmail }
//      atendimentoAte (Timestamp = agora + 2h, renovado a cada 30 min
//      enquanto o sistema do médico estiver aberto)
//  - Enquanto atendimentoAte for futuro, as regras do Firestore (ver
//    firestore.rules, função emAtendimento) recusam edição/exclusão do
//    cadastro pela RECEPÇÃO. O admin pode, com aviso.
//  - Se o navegador do médico fechar sem encerrar, a trava vence sozinha
//    (no máximo ~2h) - ninguém fica bloqueado para sempre.
//  - Ao assinar a evolução, a duração é gravada na própria evolução
//    (inicioAtendimentoISO, duracaoSegundos) e a trava é liberada.
//  - O cronômetro sobrevive a recarregar a página: ele é refeito a
//    partir do início gravado na trava.
// ========================================================

const TRAVA_MS = 2 * 60 * 60 * 1000;
const RENOVAR_MS = 30 * 60 * 1000;

const cronometros = new Map(); // idPaciente -> { inicioMs, renovadoEm }
let pacienteAberto = null;
let intervalo = null;

const el = (id) => document.getElementById(id);

function msDe(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    const t = new Date(ts).getTime();
    return Number.isNaN(t) ? 0 : t;
}

// Trava ainda válida deste documento de paciente (ou null)
export function leituraDaTrava(dados) {
    if (!dados || !dados.atendimentoEmAndamento) return null;
    return msDe(dados.atendimentoAte) > Date.now() ? dados.atendimentoEmAndamento : null;
}

function souEu(trava) {
    return (trava.porEmail || '').trim().toLowerCase() === (clinicaState.sessao.email || '').trim().toLowerCase();
}

function horaDe(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function descreverTrava(trava) {
    const h = horaDe(trava.inicioISO);
    return `${trava.porNome || 'outro profissional'}${h ? ' desde ' + h : ''}`;
}

function formatarRelogio(seg) {
    const h = Math.floor(seg / 3600);
    const m = Math.floor((seg % 3600) / 60);
    const s = seg % 60;
    return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

// "45 min", "1h 05min" - usado no histórico de evoluções
export function formatarDuracaoCurta(seg) {
    const total = Math.round(Number(seg) || 0);
    if (total < 60) return 'menos de 1 min';
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return h ? `${h}h ${String(m).padStart(2, '0')}min` : `${m} min`;
}

function inicioDaTrava(trava) {
    const p = Date.parse(trava.inicioISO);
    return Number.isNaN(p) ? Date.now() : p;
}

// ---------- barra na tela ----------
function renderizarBarra() {
    const barra = el('pep-cronometro');
    if (!barra) return;

    const mostrar = clinicaState.sessao.perfil === 'Doutor(a)' && pacienteAberto;
    barra.style.display = mostrar ? 'flex' : 'none';
    if (!mostrar) return;

    const rodando = cronometros.get(pacienteAberto.id);
    const trava = leituraDaTrava(pacienteAberto);
    const deOutro = Boolean(trava) && !souEu(trava) && !rodando;

    barra.classList.toggle('rodando', Boolean(rodando));
    barra.classList.toggle('ocupado', deOutro);

    const texto = el('pep-cron-texto');
    if (rodando) texto.textContent = `Atendimento em andamento desde ${horaDe(new Date(rodando.inicioMs).toISOString())}`;
    else if (deOutro) texto.textContent = `Paciente em atendimento com ${descreverTrava(trava)}`;
    else texto.textContent = 'Atendimento não iniciado';

    el('btn-cron-iniciar').style.display = rodando || deOutro ? 'none' : '';
    el('btn-cron-cancelar').style.display = rodando ? '' : 'none';
    atualizarRelogio();
}

function atualizarRelogio() {
    if (!pacienteAberto) return;
    const c = cronometros.get(pacienteAberto.id);
    const t = el('pep-cron-tempo');
    if (c && t) t.textContent = formatarRelogio(Math.max(0, Math.floor((Date.now() - c.inicioMs) / 1000)));
}

async function renovarTrava(idPaciente) {
    await updateDoc(doc(db, 'pacientes', idPaciente), { atendimentoAte: Timestamp.fromMillis(Date.now() + TRAVA_MS) });
}

function tique() {
    atualizarRelogio();
    cronometros.forEach((c, id) => {
        if (Date.now() - c.renovadoEm > RENOVAR_MS) {
            c.renovadoEm = Date.now();
            renovarTrava(id).catch(err => console.error('Erro ao renovar trava de atendimento: ', err));
        }
    });
}

// ---------- ações ----------
async function iniciar() {
    const pac = pacienteAberto;
    if (!pac || cronometros.has(pac.id)) return;

    const ref = doc(db, 'pacientes', pac.id);
    try {
        // Lê direto do banco: o que está na memória pode estar desatualizado
        const fresco = await getDoc(ref);
        const dadosFrescos = fresco.exists() ? fresco.data() : {};
        const trava = leituraDaTrava(dadosFrescos);

        if (trava && !souEu(trava)) {
            pac.atendimentoEmAndamento = dadosFrescos.atendimentoEmAndamento;
            pac.atendimentoAte = dadosFrescos.atendimentoAte;
            showToast(`Este paciente já está em atendimento com ${descreverTrava(trava)}.`, 'warning');
            renderizarBarra();
            return;
        }

        const inicioMs = trava ? inicioDaTrava(trava) : Date.now(); // retoma o próprio atendimento
        const dados = {
            atendimentoEmAndamento: {
                inicioISO: new Date(inicioMs).toISOString(),
                porNome: clinicaState.sessao.nome || '',
                porEmail: clinicaState.sessao.email || ''
            },
            atendimentoAte: Timestamp.fromMillis(Date.now() + TRAVA_MS)
        };
        await updateDoc(ref, dados);
        Object.assign(pac, dados);
        cronometros.set(pac.id, { inicioMs, renovadoEm: Date.now() });
        registrarAuditoria({ acao: 'Acesso', modulo: 'Prontuário', descricao: `Atendimento iniciado: ${pac.nome}` });
    } catch (error) {
        console.error('Erro ao iniciar atendimento: ', error);
        showToast('Não foi possível iniciar o cronômetro. Verifique a conexão e as regras do Firestore.', 'error');
    }
    renderizarBarra();
}

async function liberarTrava(pac) {
    await updateDoc(doc(db, 'pacientes', pac.id), {
        atendimentoEmAndamento: deleteField(),
        atendimentoAte: deleteField()
    });
    delete pac.atendimentoEmAndamento;
    delete pac.atendimentoAte;
    cronometros.delete(pac.id);
}

async function cancelar() {
    const pac = pacienteAberto;
    if (!pac || !cronometros.has(pac.id)) return;

    const ok = await confirmarAcao('Cancelar o cronômetro? O tempo é descartado e o paciente deixa de aparecer como "em atendimento".', {
        titulo: 'Cancelar atendimento', textoConfirmar: 'Cancelar atendimento'
    });
    if (!ok) return;

    try {
        await liberarTrava(pac);
        registrarAuditoria({ acao: 'Acesso', modulo: 'Prontuário', descricao: `Atendimento cancelado sem registro: ${pac.nome}` });
    } catch (error) {
        console.error('Erro ao cancelar atendimento: ', error);
        showToast('Não foi possível cancelar o atendimento agora.', 'error');
    }
    renderizarBarra();
}

// ---------- ganchos usados por pacientes.js / login.js ----------
export function initAtendimento() {
    el('btn-cron-iniciar')?.addEventListener('click', iniciar);
    el('btn-cron-cancelar')?.addEventListener('click', cancelar);
    // O botão que já existia na aba Resumo também passa a iniciar o cronômetro
    el('btn-iniciar-atendimento')?.addEventListener('click', iniciar);
    if (!intervalo) intervalo = setInterval(tique, 1000);
}

export function aoAbrirProntuarioAtendimento(paciente) {
    pacienteAberto = paciente;
    // Recarregou a página no meio do atendimento: refaz o cronômetro pela trava gravada
    if (!cronometros.has(paciente.id)) {
        const trava = leituraDaTrava(paciente);
        if (trava && souEu(trava)) {
            cronometros.set(paciente.id, { inicioMs: inicioDaTrava(trava), renovadoEm: Date.now() });
        }
    }
    renderizarBarra();
}

export function aoFecharProntuarioAtendimento() {
    pacienteAberto = null;
    renderizarBarra();
}

// Dados do cronômetro para gravar dentro da evolução (ou null se não foi iniciado)
export function lerCronometro(idPaciente) {
    const c = cronometros.get(idPaciente);
    if (!c) return null;
    return {
        inicioAtendimentoISO: new Date(c.inicioMs).toISOString(),
        duracaoSegundos: Math.max(0, Math.round((Date.now() - c.inicioMs) / 1000))
    };
}

// Campos que liberam a trava junto com o updateDoc que grava a evolução
export function camposParaLiberarTrava(idPaciente) {
    if (!cronometros.has(idPaciente)) return {};
    return { atendimentoEmAndamento: deleteField(), atendimentoAte: deleteField() };
}

export function aoSalvarAtendimento(paciente) {
    cronometros.delete(paciente.id);
    delete paciente.atendimentoEmAndamento;
    delete paciente.atendimentoAte;
    renderizarBarra();
}

// Consulta direto no banco se o paciente está em atendimento agora
// (usada pela recepção/admin antes de editar ou excluir cadastro).
// Se a leitura falhar, devolve null: quem protege de verdade são as regras.
export async function pacienteEmAtendimentoAgora(idPaciente) {
    try {
        const snap = await getDoc(doc(db, 'pacientes', idPaciente));
        return snap.exists() ? leituraDaTrava(snap.data()) : null;
    } catch (error) {
        console.error('Erro ao checar atendimento em andamento: ', error);
        return null;
    }
}

// Ao sair do sistema (botão Sair ou inatividade): solta as travas de quem
// ficou com cronômetro rodando, para a recepção não ficar bloqueada.
export async function liberarTravasDoAtendimento() {
    const ids = Array.from(cronometros.keys());
    cronometros.clear();
    for (const id of ids) {
        try {
            await updateDoc(doc(db, 'pacientes', id), {
                atendimentoEmAndamento: deleteField(),
                atendimentoAte: deleteField()
            });
        } catch (error) {
            console.error('Erro ao liberar trava de atendimento: ', error);
        }
    }
}
