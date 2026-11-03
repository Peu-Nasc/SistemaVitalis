import { clinicaState } from './state.js';
import { showToast, renderCardGrid, escapeHTML, formatCurrency } from './Ferramentas.js';
import { db } from './firebase.js';
import { collection, query, where, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { abrirProntuario } from './pacientes.js';
import { splitDoProcedimento, valorDoProcedimentoParaProfissional } from './procedimentos.js';

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
let ocultarValoresRepasse = false;

function dataLocalISO(d = new Date()) {
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const dia = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mes}-${dia}`;
}

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

// Calcula quanto o médico ganha em cada consulta respeitando o split ou valor do procedimento
function calcularRepasseDaConsulta(ag, profId) {
    const valorBase = Number(ag.valorAtendimento || 0)
        || (ag.procedimentoId ? valorDoProcedimentoParaProfissional(ag.procedimentoId, profId) : 0);
    if (!valorBase) return 0;
    const { valorProfissional } = splitDoProcedimento(ag.procedimentoId, valorBase);
    return Number(valorProfissional || 0);
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
    if (!secao || clinicaState.sessao.perfil !== 'Doutor(a)') return;

    if (dataEscutada && dataEscutada !== dataLocalISO()) {
        escutarAgendaDeHoje();
    }

    const prof = obterProfissionalLogado();
    const agora = new Date();

    const primeiroNome = (prof?.nome || clinicaState.sessao.nome || '').trim().split(/\s+/)[0] || '';
    const elSaudacao = document.getElementById('painel-saudacao');
    if (elSaudacao) elSaudacao.textContent = `${saudacaoPorHora()}, Dr(a). ${primeiroNome}`;
    const dataExtenso = agora.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
    const elData = document.getElementById('painel-data');
    if (elData) elData.textContent = dataExtenso.charAt(0).toUpperCase() + dataExtenso.slice(1);

    const elCredencial = document.getElementById('painel-credencial');
    if (!elCredencial) return;
    if (prof) {
        const partes = [prof.especialidade, prof.conselho && prof.registro ? `${prof.conselho} ${prof.registro}` : ''].filter(Boolean);
        elCredencial.textContent = partes.join(' · ');
    } else {
        elCredencial.textContent = '';
    }

    const aviso = document.getElementById('painel-aviso-vinculo');
    const meus = meusAgendamentosDeHoje();

    if (meus === null) {
        aviso.style.display = 'flex';
        aviso.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i>
            <div><strong>Seu login ainda não está vinculado a um cadastro de profissional.</strong><br>
            Peça ao administrador para cadastrar você na Equipe usando o mesmo e-mail do seu login.</div>`;
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
    const pendentesDia = meus.filter(a => a.status !== 'concluido');

    // Cálculo de Repasse em Tempo Real (Pedido Dr. Aroldo)
    const valorFaturadoHoje = concluidos.reduce((soma, a) => soma + calcularRepasseDaConsulta(a, prof.id), 0);
    const valorPrevistoRestante = pendentesDia.reduce((soma, a) => soma + calcularRepasseDaConsulta(a, prof.id), 0);

    const txtFaturado = ocultarValoresRepasse ? 'R$ ••••' : formatCurrency(valorFaturadoHoje);
    const txtPrevisto = ocultarValoresRepasse ? 'R$ ••••' : formatCurrency(valorPrevistoRestante);

    renderCardGrid('painel-kpis', [
        { id: 'painel-kpi-total', label: 'Consultas Hoje', initial: String(meus.length), variant: 'primary' },
        { id: 'painel-kpi-fila', label: 'Na Fila Agora', initial: String(fila.length), variant: 'warning', valueClass: 'warning' },
        { id: 'painel-kpi-faturado', label: 'Já Faturado Hoje (Meu Repasse)', initial: txtFaturado, variant: 'success', valueClass: 'positivo' },
        { id: 'painel-kpi-previsto', label: 'A Faturar Hoje (Restante)', initial: txtPrevisto, variant: 'primary' }
    ]);

    // Adiciona botão de olho no card de faturamento para privacidade no consultório
    const cardFaturado = document.getElementById('painel-kpi-faturado')?.parentElement;
    if (cardFaturado && !cardFaturado.querySelector('.btn-toggle-privacidade')) {
        const btnOlho = document.createElement('button');
        btnOlho.type = 'button';
        btnOlho.className = 'btn-evo-mini btn-toggle-privacidade';
        btnOlho.style.marginTop = '6px';
        btnOlho.innerHTML = `<i class="fa-regular ${ocultarValoresRepasse ? 'fa-eye' : 'fa-eye-slash'}"></i> ${ocultarValoresRepasse ? 'Mostrar valores' : 'Ocultar valores'}`;
        btnOlho.addEventListener('click', () => {
            ocultarValoresRepasse = !ocultarValoresRepasse;
            renderizarPainelMedico();
        });
        cardFaturado.appendChild(btnOlho);
    }

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

export function initPainelMedico() {
    const secao = document.getElementById('painel-medico');
    if (!secao) return;

    secao.addEventListener('click', (e) => {
        const btnAbrir = e.target.closest('.btn-painel-abrir');
        if (btnAbrir) {
            abrirProntuario(btnAbrir.getAttribute('data-pac-id'), { aba: btnAbrir.getAttribute('data-aba') || 'tab-evolucao' });
            return;
        }
        const atalho = e.target.closest('.painel-atalho');
        if (atalho) {
            document.querySelector(`.menu-btn[data-target="${atalho.dataset.ir}"]`)?.click();
        }
    });
}

export function iniciarPainelMedico() {
    if (clinicaState.sessao.perfil !== 'Doutor(a)') return;

    escutarAgendaDeHoje();
    renderizarPainelMedico();

    if (!intervaloRelogio) {
        intervaloRelogio = setInterval(() => {
            const aberto = document.getElementById('painel-medico')?.classList.contains('active');
            if (aberto) renderizarPainelMedico();
        }, 60000);
    }
}