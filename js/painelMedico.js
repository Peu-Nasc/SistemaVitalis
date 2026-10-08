import { clinicaState } from './state.js';
import { showToast, renderCardGrid, escapeHTML } from './Ferramentas.js';
import { db } from './firebase.js';
import { collection, query, where, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { abrirProntuario } from './pacientes.js';

// ========================================================
// PAINEL DO MÉDICO ("Meu Painel")
// Tela inicial do perfil Doutor(a): só mostra o que importa pra rotina
// de consultório - quem já chegou e está esperando (fila), a agenda do
// dia dele e atalhos. Nada de financeiro ou gestão (isso continua
// restrito ao Administrador/Recepção, ver login.js).
//
// TEMPO REAL: a agenda do resto do sistema é carregada uma vez só
// (getDocs). Aqui isso não serve: a recepção marca o paciente como
// "Aguardando Atendimento" e o médico precisa ver na hora, sem recarregar
// a página. Por isso este módulo tem a própria escuta (onSnapshot) só
// dos agendamentos do dia atual - leve e sem tocar no clinicaState.agenda.
// ========================================================

const ROTULO_STATUS = {
    agendado: { texto: 'Agendado', classe: 'neutral' },
    confirmado: { texto: 'Confirmado', classe: 'info' },
    aguardando_atendimento: { texto: 'Aguardando', classe: 'warning' },
    concluido: { texto: 'Concluído', classe: 'success' }
};

let agendamentosHoje = [];
let cancelarEscuta = null;
let dataEscutada = null;
let primeiraCarga = true;
let aguardandoConhecidos = new Set();
let intervaloRelogio = null;

// Data local no formato YYYY-MM-DD (o mesmo do <input type="date"> da
// Agenda). Não usar toISOString(): ele converte pra UTC e, à noite no
// Brasil, devolveria o dia seguinte.
function dataLocalISO(d = new Date()) {
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const dia = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mes}-${dia}`;
}

// O login não guarda o ID do cadastro de profissional na sessão, então
// o vínculo é feito pelo e-mail (cadastrado em Equipe = e-mail do login)
// e, se não achar, pelo nome - mesmo critério que o prontuário já usa
// pra travar a assinatura (ver abrirProntuario em pacientes.js).
function obterProfissionalLogado() {
    const emailSessao = (clinicaState.sessao.email || '').trim().toLowerCase();
    const nomeSessao = (clinicaState.sessao.nome || '').trim().toLowerCase();

    const porEmail = emailSessao && clinicaState.profissionais.find(p =>
        (p.email || '').trim().toLowerCase() === emailSessao
    );
    if (porEmail) return porEmail;

    return clinicaState.profissionais.find(p =>
        (p.nome || '').trim().toLowerCase() === nomeSessao
    ) || null;
}

function meusAgendamentosDeHoje() {
    const prof = obterProfissionalLogado();
    if (!prof) return null;
    return agendamentosHoje
        .filter(a => String(a.profId) === String(prof.id) && a.status !== 'cancelado')
        .sort((a, b) => (a.hora || '').localeCompare(b.hora || ''));
}

function escutarAgendaDeHoje() {
    const hoje = dataLocalISO();
    if (cancelarEscuta && dataEscutada === hoje) return;
    if (cancelarEscuta) cancelarEscuta();

    dataEscutada = hoje;
    primeiraCarga = true;
    aguardandoConhecidos = new Set();

    const q = query(
        collection(db, "agendamentos"),
        where("clinicaId", "==", clinicaState.sessao.clinicaId),
        where("data", "==", hoje)
    );

    cancelarEscuta = onSnapshot(q, (snapshot) => {
        agendamentosHoje = snapshot.docs.map(d => ({ ...d.data(), id: String(d.id) }));
        avisarNovosAguardando();
        renderizarPainelMedico();
    }, (error) => {
        console.error("Erro ao acompanhar a agenda do dia: ", error);
        showToast('Não foi possível acompanhar a fila em tempo real. Recarregue a página.', 'warning');
    });
}

// Avisa (toast) quando um paciente DESTE médico passa a "Aguardando".
// Na primeira carga só memoriza quem já estava na fila, pra não disparar
// aviso de gente que chegou antes dele abrir o sistema.
function avisarNovosAguardando() {
    const meus = meusAgendamentosDeHoje() || [];
    const aguardando = meus.filter(a => a.status === 'aguardando_atendimento');

    if (!primeiraCarga) {
        aguardando.forEach(a => {
            if (!aguardandoConhecidos.has(a.id)) {
                showToast(`${a.pacNome} chegou e está aguardando atendimento.`, 'warning');
            }
        });
    }

    aguardandoConhecidos = new Set(aguardando.map(a => a.id));
    primeiraCarga = false;
}

function saudacaoPorHora() {
    const h = new Date().getHours();
    if (h < 12) return 'Bom dia';
    if (h < 18) return 'Boa tarde';
    return 'Boa noite';
}

function linhaAgenda(a) {
    const st = ROTULO_STATUS[a.status] || ROTULO_STATUS.agendado;
    const concluido = a.status === 'concluido';
    const tipo = a.procedimentoNome || a.tipo || 'Consulta';
    const sala = a.sala ? ` · Sala ${escapeHTML(String(a.sala))}` : '';
    const botao = a.pacId
        ? `<button type="button" class="btn-action btn-painel-abrir" data-pac-id="${escapeHTML(String(a.pacId))}" title="Abrir prontuário"><i class="fa-solid fa-notes-medical"></i></button>`
        : '';

    return `
        <div class="painel-linha${concluido ? ' concluido' : ''}" data-status="${escapeHTML(a.status || 'agendado')}">
            <div class="painel-hora">${escapeHTML(a.hora || '--:--')}</div>
            <div class="painel-linha-info">
                <strong>${escapeHTML(a.pacNome || 'Paciente')}</strong>
                <small>${escapeHTML(tipo)}${sala}</small>
            </div>
            <span class="badge ${st.classe}">${st.texto}</span>
            ${botao}
        </div>`;
}

function itemFila(a, posicao) {
    const tipo = a.procedimentoNome || a.tipo || 'Consulta';
    const sala = a.sala ? ` · Sala ${escapeHTML(String(a.sala))}` : '';
    return `
        <div class="fila-item">
            <div class="fila-posicao">${posicao}º</div>
            <div class="painel-linha-info">
                <strong>${escapeHTML(a.pacNome || 'Paciente')}</strong>
                <small>Horário ${escapeHTML(a.hora || '--:--')} · ${escapeHTML(tipo)}${sala}</small>
            </div>
            ${a.pacId ? `<button type="button" class="btn-primary btn-painel-abrir" data-aba="tab-evolucao" data-pac-id="${escapeHTML(String(a.pacId))}"><i class="fa-solid fa-stethoscope"></i> Atender</button>` : ''}
        </div>`;
}

export function renderizarPainelMedico() {
    const secao = document.getElementById('painel-medico');
    if (!secao) return;
    // Tela exclusiva do Doutor(a): qualquer outro perfil não renderiza nada
    if (clinicaState.sessao.perfil !== 'Doutor(a)') return;

    // Se o dia virou com o sistema aberto, troca a escuta pro dia novo
    if (clinicaState.sessao.perfil === 'Doutor(a)' && dataEscutada && dataEscutada !== dataLocalISO()) {
        escutarAgendaDeHoje();
    }

    const prof = obterProfissionalLogado();
    const agora = new Date();

    // Cabeçalho
    const primeiroNome = (prof?.nome || clinicaState.sessao.nome || '').trim().split(/\s+/)[0] || '';
    const elSaudacao = document.getElementById('painel-saudacao');
    if (elSaudacao) elSaudacao.textContent = `${saudacaoPorHora()}, Dr(a). ${primeiroNome}`;
    const dataExtenso = agora.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
    const elData = document.getElementById('painel-data');
    if (elData) elData.textContent = dataExtenso.charAt(0).toUpperCase() + dataExtenso.slice(1);

    const elCredencial = document.getElementById('painel-credencial');
    if (!elCredencial) return;
    if (prof) {
        const partes = [prof.especialidade, prof.conselho && prof.registro ? `${prof.conselho} ${prof.registro}` : '']
            .filter(Boolean);
        elCredencial.textContent = partes.join(' · ');
    } else {
        elCredencial.textContent = '';
    }

    const aviso = document.getElementById('painel-aviso-vinculo');
    const meus = meusAgendamentosDeHoje();

    // Login sem cadastro correspondente na Equipe: não dá pra saber quais
    // consultas são dele, então não mostra a agenda de ninguém.
    if (meus === null) {
        aviso.style.display = 'flex';
        aviso.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i>
            <div><strong>Seu login ainda não está vinculado a um cadastro de profissional.</strong><br>
            Peça ao administrador para cadastrar você na Equipe usando o mesmo e-mail do seu login. Assim sua fila e sua agenda aparecem aqui.</div>`;
        renderCardGrid('painel-kpis', []);
        document.getElementById('painel-fila').innerHTML = '';
        document.getElementById('painel-agenda').innerHTML = '';
        document.getElementById('painel-fila-contador').textContent = '0';
        renderizarAtalhos();
        return;
    }
    aviso.style.display = 'none';

    const fila = meus.filter(a => a.status === 'aguardando_atendimento');
    const concluidos = meus.filter(a => a.status === 'concluido');
    const horaAgora = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;
    const proxima = meus.find(a => (a.status === 'agendado' || a.status === 'confirmado') && (a.hora || '') >= horaAgora);

    renderCardGrid('painel-kpis', [
        { id: 'painel-kpi-total', label: 'Consultas Hoje', initial: String(meus.length), variant: 'primary' },
        { id: 'painel-kpi-fila', label: 'Na Fila Agora', initial: String(fila.length), variant: 'warning', valueClass: 'warning' },
        { id: 'painel-kpi-feitos', label: 'Atendidos', initial: String(concluidos.length), variant: 'success', valueClass: 'positivo' },
        { id: 'painel-kpi-proxima', label: 'Próxima Consulta', initial: proxima ? proxima.hora : '—', variant: 'primary' }
    ]);

    document.getElementById('painel-fila-contador').textContent = String(fila.length);
    document.getElementById('painel-fila').innerHTML = fila.length
        ? fila.map((a, i) => itemFila(a, i + 1)).join('')
        : `<div class="painel-vazio"><i class="fa-regular fa-circle-check"></i>
            <p>Nenhum paciente aguardando.</p>
            <small>Quando a recepção registrar a chegada de um paciente seu, ele aparece aqui automaticamente.</small></div>`;

    document.getElementById('painel-agenda').innerHTML = meus.length
        ? meus.map(linhaAgenda).join('')
        : `<div class="painel-vazio"><i class="fa-regular fa-calendar"></i>
            <p>Nenhuma consulta marcada para hoje.</p></div>`;

    renderizarAtalhos();
}

function renderizarAtalhos() {
    const el = document.getElementById('painel-atalhos');
    if (!el) return;

    const pendentes = (clinicaState.notificacoes || []).filter(n => n.status === 'pendente').length;

    el.innerHTML = `
        <button type="button" class="painel-atalho" data-ir="pacientes">
            <i class="fa-solid fa-users"></i><span>Pacientes e Prontuários</span>
        </button>
        <button type="button" class="painel-atalho" data-ir="agenda">
            <i class="fa-regular fa-calendar-days"></i><span>Agenda completa</span>
        </button>
        <button type="button" class="painel-atalho" data-ir="notificacoes">
            <i class="fa-solid fa-bell"></i><span>Notificações</span>
            ${pendentes ? `<em class="painel-atalho-contador">${pendentes}</em>` : ''}
        </button>`;
}

// Liga os cliques UMA vez (delegação): abrir prontuário e atalhos.
export function initPainelMedico() {
    const secao = document.getElementById('painel-medico');
    if (!secao) return;

    secao.addEventListener('click', (e) => {
        const btnAbrir = e.target.closest('.btn-painel-abrir');
        if (btnAbrir) {
            // "Atender" (fila) já abre direto na aba de atendimento
            abrirProntuario(btnAbrir.getAttribute('data-pac-id'), { aba: btnAbrir.getAttribute('data-aba') || undefined });
            return;
        }
        const atalho = e.target.closest('.painel-atalho');
        if (atalho) {
            document.querySelector(`.menu-btn[data-target="${atalho.dataset.ir}"]`)?.click();
        }
    });
}

// Chamada por login.js depois que a sessão e os profissionais já foram
// carregados - só então dá pra descobrir quem é o médico logado.
export function iniciarPainelMedico() {
    if (clinicaState.sessao.perfil !== 'Doutor(a)') return;

    // Qualquer falha aqui não pode travar o login (a tela de login só some
    // depois que esta função retorna)
    try {
        escutarAgendaDeHoje();
        renderizarPainelMedico();
    } catch (error) {
        console.error("Erro ao iniciar o painel do médico: ", error);
        showToast('Não foi possível carregar o Meu Painel.', 'error');
    }

    // Atualiza "próxima consulta" e vira o dia sozinho, sem depender de
    // novo snapshot do banco
    if (!intervaloRelogio) {
        intervaloRelogio = setInterval(() => {
            const aberto = document.getElementById('painel-medico')?.classList.contains('active');
            if (aberto) renderizarPainelMedico();
        }, 60000);
    }
}

// Encerra a escuta em tempo real e zera o estado do módulo.
export function pararPainelMedico() {
    if (cancelarEscuta) cancelarEscuta();
    cancelarEscuta = null;
    dataEscutada = null;
    agendamentosHoje = [];
    aguardandoConhecidos = new Set();
    primeiraCarga = true;
    if (intervaloRelogio) {
        clearInterval(intervaloRelogio);
        intervaloRelogio = null;
    }
}