import { clinicaState } from './state.js';
import { showToast, comEstadoDeCarregamento, escapeHTML, confirmarAcao, formatCurrency } from './Ferramentas.js';
import { db } from './firebase.js';
import { collection, addDoc, getDocs, doc, deleteDoc, updateDoc, query, where } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { criarNotificacao } from './notificacoes.js';
import { registrarAuditoria } from './auditoria.js';
import { valorDoProcedimentoParaProfissional } from './procedimentos.js';

let agendamentoIdParaAtualizar = null;

// ========================================================
// NOVO: ALTERNADOR DE PERÍODO (Dia / Semana / Mês)
// periodoAtual controla qual das 3 visões é renderizada por
// atualizarAgenda(). O input #data-agenda continua sendo a
// "data de referência": no dia, é o próprio dia; na semana, é
// qualquer dia daquela semana; no mês, qualquer dia daquele mês.
// ========================================================
let periodoAtual = 'dia';

const NOMES_MES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const NOMES_DIA_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// Evita problema de fuso horário do JS ao interpretar "YYYY-MM-DD" como
// UTC (o que às vezes "voltava" um dia) - construímos a data em horário local.
function parseDataLocal(isoDate) {
    const [ano, mes, dia] = isoDate.split('-').map(Number);
    return new Date(ano, mes - 1, dia);
}

function paraIsoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Domingo da semana que contém a data de referência
function obterDomingoDaSemana(d) {
    const domingo = new Date(d);
    domingo.setDate(domingo.getDate() - domingo.getDay());
    return domingo;
}

// Retorna o bloqueio (folga/indisponibilidade) que cobre esse profissional+data+horário, se existir
function obterBloqueio(profId, data, hora) {
    return clinicaState.agenda.bloqueios.find(b => {
        if (String(b.profId) !== String(profId) || b.data !== data) return false;
        if (b.tipo === 'dia_inteiro') return true;
        return hora >= b.horaInicio && hora <= b.horaFim;
    });
}

async function registrarPagamentoAgendamento(agendamento, formaPagamento, valorPago) {
    if (!agendamento) return;

    const valorBruto = parseFloat((valorPago ?? agendamento.valorAtendimento ?? 0).toString().replace(/\./g, '').replace(',', '.'));
    if (!valorBruto || valorBruto <= 0) return;

    const profissional = clinicaState.profissionais.find(p => String(p.id) === String(agendamento.profId));
    const hoje = new Date().toISOString().split('T')[0];
    const agoraIso = new Date().toISOString();

    await addDoc(collection(db, "financeiro"), {
        tipo: 'Receita',
        vinculo: `Consulta de ${agendamento.pacNome} - ${agendamento.procedimentoNome || agendamento.tipo || 'Consulta'}`,
        pagamento: formaPagamento,
        status: 'Recebido/Pago',
        competencia: hoje,
        caixa: hoje,
        valor: valorBruto,
        profissionalId: agendamento.profId || null,
        profissionalNome: profissional ? profissional.nome : null,
        clinicaId: clinicaState.sessao.clinicaId,
        origem: 'agendamento',
        agendamentoId: agendamento.id || null,
        pacienteId: agendamento.pacId || null,
        pacienteNome: agendamento.pacNome || null,
        procedimentoId: agendamento.procedimentoId || null,
        procedimentoNome: agendamento.procedimentoNome || null,
        dataConsulta: agendamento.data || null,
        horaConsulta: agendamento.hora || null,
        pagoEm: agoraIso,
        pagoPor: clinicaState.sessao.nome || null
    });

    await registrarAuditoria({
        acao: 'Criação',
        modulo: 'Financeiro',
        descricao: `Pagamento confirmado: ${agendamento.pacNome} - ${agendamento.procedimentoNome || agendamento.tipo || 'Consulta'} (${formatCurrency(valorBruto)})`
    });
}

function abrirModalPagamento(idAgendamento) {
    const modal = document.getElementById('modal-confirmar-agendamento');
    const form = document.getElementById('form-confirmar-agendamento');
    const agendamento = clinicaState.agenda.agendamentos.find(a => String(a.id) === String(idAgendamento));

    if (!modal || !form || !agendamento) return;

    agendamentoIdParaAtualizar = idAgendamento;
    form.reset();

    const valorBase = Number((agendamento.valorAtendimento ?? 0));
    const inputValor = document.getElementById('pagamento-valor');
    if (inputValor) {
        inputValor.value = valorBase.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    const selectPagamento = document.getElementById('pagamento-forma');
    if (selectPagamento) {
        selectPagamento.value = 'Pix';
    }

    modal.classList.add('active');
}

function obterValorProcedimentoSelecionado() {
    const tipoAtendimento = document.getElementById('agenda-tipo')?.value;
    const selectProcedimento = document.getElementById('agenda-procedimento');
    const profissionalId = document.getElementById('agenda-profissional')?.value;

    if (tipoAtendimento !== 'procedimento_avulso' || !selectProcedimento || !profissionalId) {
        return 0;
    }

    const procedimentoId = selectProcedimento.value;
    if (!procedimentoId) return 0;

    return valorDoProcedimentoParaProfissional(procedimentoId, profissionalId);
}

function atualizarVisualizacaoProcedimento() {
    const tipoAtendimento = document.getElementById('agenda-tipo')?.value;
    const selectProcedimento = document.getElementById('agenda-procedimento');
    const campoValor = document.getElementById('agenda-valor');
    const grupoProcedimento = document.getElementById('grupo-agenda-procedimento');

    if (!selectProcedimento || !campoValor || !grupoProcedimento) return;

    const isAvulso = tipoAtendimento === 'procedimento_avulso';
    grupoProcedimento.style.display = isAvulso ? 'block' : 'none';
    selectProcedimento.disabled = !isAvulso;

    if (!isAvulso) {
        campoValor.value = formatCurrency(0);
        return;
    }

    const procedimentoId = selectProcedimento.value;
    const valor = obterValorProcedimentoSelecionado();
    campoValor.value = formatCurrency(valor);

    if (!procedimentoId && clinicaState.procedimentos.length > 0) {
        const primeiro = clinicaState.procedimentos[0];
        selectProcedimento.value = String(primeiro.id);
        campoValor.value = formatCurrency(valorDoProcedimentoParaProfissional(primeiro.id, document.getElementById('agenda-profissional')?.value || ''));
    }
}

function popularSelectProcedimentos() {
    const selectProcedimento = document.getElementById('agenda-procedimento');
    if (!selectProcedimento) return;

    const profId = document.getElementById('agenda-profissional')?.value || '';
    selectProcedimento.innerHTML = '<option value="">Selecione o procedimento...</option>' +
        clinicaState.procedimentos.map(proc => {
            const valor = valorDoProcedimentoParaProfissional(proc.id, profId);
            return `<option value="${proc.id}">${escapeHTML(proc.nome)} - ${formatCurrency(valor)}</option>`;
        }).join('');

    if (clinicaState.procedimentos.length > 0) {
        const valorPadrao = document.getElementById('agenda-tipo')?.value === 'procedimento_avulso' ? clinicaState.procedimentos[0].id : '';
        if (valorPadrao) selectProcedimento.value = String(valorPadrao);
    }
}

export function verificarAlertasAgendamento() {
    // Função silenciada: os alertas agora aparecem silenciosamente no Dashboard
}

export function initAgenda() {
    const modalAgenda = document.getElementById('modal-agendamento');
    const inputDataAgenda = document.getElementById('data-agenda');
    const filtroProfissional = document.getElementById('filtro-profissional');
    
    inputDataAgenda.value = new Date().toISOString().split('T')[0];
    
    document.getElementById('btn-novo-agendamento').addEventListener('click', () => abrirModalAgendamento());
    document.getElementById('btn-close-agendamento').addEventListener('click', () => modalAgenda.classList.remove('active'));
    
    inputDataAgenda.addEventListener('change', atualizarAgenda);
    filtroProfissional.addEventListener('change', atualizarAgenda);

    document.getElementById('agenda-data').addEventListener('change', atualizarDisponibilidadeSalas);
    document.getElementById('agenda-hora').addEventListener('change', atualizarDisponibilidadeSalas);

    const tipoAtendimento = document.getElementById('agenda-tipo');
    const selectProcedimento = document.getElementById('agenda-procedimento');
    const selectProfissional = document.getElementById('agenda-profissional');

    if (tipoAtendimento) {
        tipoAtendimento.addEventListener('change', () => {
            popularSelectProcedimentos();
            atualizarVisualizacaoProcedimento();
        });
    }

    if (selectProcedimento) {
        selectProcedimento.addEventListener('change', atualizarVisualizacaoProcedimento);
    }

    if (selectProfissional) {
        selectProfissional.addEventListener('change', () => {
            popularSelectProcedimentos();
            atualizarVisualizacaoProcedimento();
        });
    }

    // ==========================================
    // BLOQUEIO DE HORÁRIO / FOLGA
    // ==========================================
    const modalBloqueio = document.getElementById('modal-bloqueio');
    const selectTipoBloqueio = document.getElementById('bloqueio-tipo');
    const grupoHorarioEspecifico = document.getElementById('bloqueio-horario-especifico-group');

    document.getElementById('btn-novo-bloqueio').addEventListener('click', () => abrirModalBloqueio());
    document.getElementById('btn-close-bloqueio').addEventListener('click', () => modalBloqueio.classList.remove('active'));

    selectTipoBloqueio.addEventListener('change', (e) => {
        grupoHorarioEspecifico.style.display = e.target.value === 'horario' ? 'grid' : 'none';
    });

    document.getElementById('form-bloqueio').addEventListener('submit', async (e) => {
        e.preventDefault();

        const btnSalvar = e.target.querySelector('button[type="submit"]');

        await comEstadoDeCarregamento(btnSalvar, 'Bloqueando...', async () => {
            const profId = document.getElementById('bloqueio-profissional').value;
            const data = document.getElementById('bloqueio-data').value;
            const tipo = selectTipoBloqueio.value;
            const horaInicio = tipo === 'horario' ? document.getElementById('bloqueio-hora-inicio').value : null;
            const horaFim = tipo === 'horario' ? document.getElementById('bloqueio-hora-fim').value : null;

            if (tipo === 'horario' && horaInicio > horaFim) {
                showToast('O horário de início não pode ser depois do horário de fim.', 'error');
                return;
            }

            const conflito = clinicaState.agenda.agendamentos.some(a => {
                if (a.profId !== String(profId) || a.data !== data) return false;
                if (tipo === 'dia_inteiro') return true;
                return a.hora >= horaInicio && a.hora <= horaFim;
            });

            if (conflito) {
                showToast('Já existe consulta marcada nesse período. Cancele a consulta antes de bloquear o horário.', 'error');
                return;
            }

            try {
                const profissional = clinicaState.profissionais.find(p => String(p.id) === String(profId));
                const motivo = document.getElementById('bloqueio-motivo').value;

                await addDoc(collection(db, "bloqueios_agenda"), {
                    profId: String(profId),
                    data,
                    tipo,
                    horaInicio,
                    horaFim,
                    motivo,
                    bloqueadoPor: clinicaState.sessao.nome,
                    clinicaId: clinicaState.sessao.clinicaId
                });

                modalBloqueio.classList.remove('active');
                e.target.reset();
                grupoHorarioEspecifico.style.display = 'none';
                showToast('Horário bloqueado com sucesso.', 'success');

                await registrarAuditoria({
                    acao: 'Criação',
                    modulo: 'Agenda',
                    descricao: `Horário bloqueado para ${profissional ? profissional.nome : profId} em ${data}${tipo === 'dia_inteiro' ? ' (dia inteiro)' : ` (${horaInicio} às ${horaFim})`}${motivo ? ' - ' + motivo : ''}`
                });

                await carregarBloqueios();
            } catch (error) {
                console.error("Erro ao bloquear horário: ", error);
                showToast('Falha de conexão ao bloquear horário.', 'error');
            }
        });
    });

    document.getElementById('form-agendamento').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const btnSalvar = e.target.querySelector('button[type="submit"]');

        await comEstadoDeCarregamento(btnSalvar, 'Agendando...', async () => {
            const pacId = document.getElementById('agenda-paciente').value;
            const profId = document.getElementById('agenda-profissional').value;
            const sala = document.getElementById('agenda-sala').value;
            const dataAgendamento = document.getElementById('agenda-data').value;
            const horaAgendamento = document.getElementById('agenda-hora').value;
            const tipoAtendimento = document.getElementById('agenda-tipo').value;
            const selectProcedimento = document.getElementById('agenda-procedimento');
            const procedimentoId = tipoAtendimento === 'procedimento_avulso' ? (selectProcedimento ? selectProcedimento.value : '') : '';
            const procedimento = clinicaState.procedimentos.find(p => String(p.id) === String(procedimentoId));
            const valorAtendimento = tipoAtendimento === 'procedimento_avulso' ? obterValorProcedimentoSelecionado() : 0;
            const paciente = clinicaState.pacientes.find(p => String(p.id) === String(pacId));

            if (tipoAtendimento === 'procedimento_avulso' && (!procedimentoId || !procedimento)) {
                showToast('Selecione um procedimento válido para o atendimento avulso.', 'error');
                return;
            }

            if (!sala) {
                showToast('Selecione a sala onde a consulta vai acontecer.', 'error');
                return;
            }

            // === NOVA TRAVA: IMPEDE O MESMO PACIENTE NO MESMO HORÁRIO ===
            const pacienteOcupado = clinicaState.agenda.agendamentos.find(a => 
                String(a.pacId) === String(pacId) && 
                a.data === dataAgendamento && 
                a.hora === horaAgendamento &&
                a.status !== 'cancelado'
            );

            if (pacienteOcupado) {
                showToast(`O paciente ${paciente ? paciente.nome : ''} já possui uma consulta neste mesmo horário (Sala ${pacienteOcupado.sala}).`, 'error');
                return;
            }

            const ehAdmin = clinicaState.sessao.perfil === 'admin';

            const horarioOcupado = clinicaState.agenda.agendamentos.find(a => 
                a.profId === String(profId) && 
                a.data === dataAgendamento && 
                a.hora === horaAgendamento &&
                a.status !== 'cancelado'
            );

            if (horarioOcupado) {
                if (ehAdmin) {
                    const forcar = await confirmarAcao(
                        'Este médico já tem um paciente agendado neste horário. Como Administrador, você pode forçar um segundo agendamento no mesmo horário mesmo assim. Deseja continuar?',
                        { titulo: 'Horário já ocupado', textoConfirmar: 'Agendar mesmo assim', perigoso: true }
                    );
                    if (!forcar) return;
                } else {
                    showToast('Atenção: Este médico já possui um paciente agendado neste horário!', 'error');
                    return; 
                }
            }

            const salaOcupada = clinicaState.agenda.agendamentos.find(a =>
                String(a.sala) === String(sala) &&
                a.data === dataAgendamento &&
                a.hora === horaAgendamento &&
                a.status !== 'cancelado'
            );

            if (salaOcupada) {
                if (ehAdmin) {
                    const forcar = await confirmarAcao(
                        `A Sala ${sala} já está ocupada por outro profissional nesse horário. Como Administrador, você pode forçar esse agendamento mesmo assim. Deseja continuar?`,
                        { titulo: 'Sala já ocupada', textoConfirmar: 'Agendar mesmo assim', perigoso: true }
                    );
                    if (!forcar) return;
                } else {
                    showToast(`A Sala ${sala} já está ocupada por outro profissional nesse horário.`, 'error');
                    return;
                }
            }

            const bloqueio = obterBloqueio(profId, dataAgendamento, horaAgendamento);
            if (bloqueio) {
                if (ehAdmin) {
                    const forcar = await confirmarAcao(
                        'Este horário está bloqueado (folga/indisponibilidade) para este profissional. Como Administrador, você pode agendar mesmo assim. Deseja continuar?',
                        { titulo: 'Horário bloqueado', textoConfirmar: 'Agendar mesmo assim', perigoso: true }
                    );
                    if (!forcar) return;
                } else {
                    showToast('Este horário está bloqueado (folga/indisponibilidade) para este profissional.', 'error');
                    return;
                }
            }

            try {
                await addDoc(collection(db, "agendamentos"), {
                    pacId: String(pacId),
                    pacNome: paciente ? paciente.nome : 'Paciente',
                    profId: String(profId),
                    sala: String(sala),
                    data: dataAgendamento,
                    hora: horaAgendamento,
                    tipo: tipoAtendimento === 'procedimento_avulso' ? 'Procedimento avulso' : 'Sessão de Pacote',
                    procedimentoId: procedimentoId || '',
                    procedimentoNome: procedimento ? procedimento.nome : (tipoAtendimento === 'procedimento_avulso' ? 'Procedimento' : 'Sessão de Pacote'),
                    valorAtendimento: valorAtendimento,
                    statusPagamento: tipoAtendimento === 'procedimento_avulso' ? 'pendente' : 'nao_aplica',
                    status: 'agendado', 
                    clinicaId: clinicaState.sessao.clinicaId
                });
                
                modalAgenda.classList.remove('active');
                e.target.reset();
                showToast('Consulta agendada com sucesso!', 'success');

                // AUTO-RESOLUÇÃO: se esse paciente tinha um "Retorno Pendente"
                // ou "Encaminhamento" esperando agendamento, a ação que a
                // notificação pedia acabou de acontecer agora - resolve
                // sozinho, sem precisar que alguém volte em Notificações pra
                // marcar manualmente.
                const pendenciasResolvidasAoAgendar = clinicaState.notificacoes.filter(n =>
                    n.status === 'pendente' &&
                    String(n.pacienteId) === String(pacId) &&
                    (n.tipo === 'retorno_pendente' || n.tipo === 'encaminhamento')
                );
                for (const pend of pendenciasResolvidasAoAgendar) {
                    try {
                        await updateDoc(doc(db, "notificacoes", pend.id), {
                            status: 'concluida',
                            resolvidoPor: clinicaState.sessao.nome,
                            resolvidoEm: new Date().toISOString(),
                            resolvidoAutomaticamente: true
                        });
                    } catch (err) {
                        console.error("Erro ao auto-resolver notificação vinculada: ", err);
                    }
                }
                
                await carregarAgendamentos(); 
            } catch (error) {
                console.error("Erro ao agendar: ", error);
                showToast('Falha de conexão ao agendar.', 'error');
            }
        });
    });

    const modalConfirmarAgendamento = document.getElementById('modal-confirmar-agendamento');
    const modalCancelarAgendamento = document.getElementById('modal-cancelar-agendamento');

    function fecharModaisDeStatus() {
        modalConfirmarAgendamento.classList.remove('active');
        modalCancelarAgendamento.classList.remove('active');
        agendamentoIdParaAtualizar = null;
        atualizarAgenda();
    }

    document.getElementById('btn-close-confirmar-agendamento').addEventListener('click', fecharModaisDeStatus);
    document.getElementById('btn-close-cancelar-agendamento').addEventListener('click', fecharModaisDeStatus);

    document.getElementById('form-confirmar-agendamento').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!agendamentoIdParaAtualizar) return;

        const btnSalvar = e.target.querySelector('button[type="submit"]');
        const idAgendamento = agendamentoIdParaAtualizar;
        const agendamento = clinicaState.agenda.agendamentos.find(a => String(a.id) === String(idAgendamento));

        if (!agendamento) {
            showToast('Agendamento não localizado. Recarregue a página e tente novamente.', 'error');
            return;
        }

        const valorTexto = document.getElementById('pagamento-valor').value.replace(/\./g, '').replace(',', '.');
        const valorPago = parseFloat(valorTexto);
        const formaPagamento = document.getElementById('pagamento-forma').value;

        if (!formaPagamento) {
            showToast('Selecione a forma de pagamento.', 'error');
            return;
        }

        if (!valorPago || valorPago <= 0) {
            showToast('Informe um valor válido para o pagamento.', 'error');
            return;
        }

        await comEstadoDeCarregamento(btnSalvar, 'Confirmando...', async () => {
            try {
                const statusFinal = agendamento.status === 'concluido' ? 'concluido' : 'confirmado';
                const updateData = {
                    status: statusFinal,
                    statusPagamento: 'pago',
                    valorAtendimento: valorPago,
                    pagoEm: new Date().toISOString(),
                    pagoPor: clinicaState.sessao.nome,
                    observacaoConfirmacao: {
                        whatsapp: document.getElementById('confirmacao-whatsapp').checked,
                        pagamento: true,
                        chegou: document.getElementById('confirmacao-chegou').checked,
                        observacoes: document.getElementById('confirmacao-observacoes').value,
                        formaPagamento,
                        valorPago
                    }
                };

                await Promise.all([
                    updateDoc(doc(db, "agendamentos", idAgendamento), updateData),
                    registrarPagamentoAgendamento({
                        ...agendamento,
                        valorAtendimento: valorPago,
                        status: statusFinal
                    }, formaPagamento, valorPago)
                ]);

                const idxAgendamento = clinicaState.agenda.agendamentos.findIndex(a => String(a.id) === String(idAgendamento));
                if (idxAgendamento >= 0) {
                    clinicaState.agenda.agendamentos[idxAgendamento] = {
                        ...clinicaState.agenda.agendamentos[idxAgendamento],
                        ...updateData
                    };
                }

                showToast('Pagamento confirmado e lançado no caixa!', 'success');
                modalConfirmarAgendamento.classList.remove('active');
                e.target.reset();
                agendamentoIdParaAtualizar = null;
                atualizarAgenda(); 
            } catch (error) {
                console.error("Erro ao confirmar pagamento: ", error);
                showToast('Erro ao confirmar pagamento.', 'error');
            }
        });
    });

    document.getElementById('form-cancelar-agendamento').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!agendamentoIdParaAtualizar) return;

        const btnSalvar = e.target.querySelector('button[type="submit"]');
        const idAgendamento = agendamentoIdParaAtualizar;

        await comEstadoDeCarregamento(btnSalvar, 'Cancelando...', async () => {
            try {
                await updateDoc(doc(db, "agendamentos", idAgendamento), {
                    status: 'cancelado',
                    motivoCancelamento: document.getElementById('cancelamento-motivo').value,
                    canceladoPor: clinicaState.sessao.nome,
                    canceladoEm: new Date().toISOString()
                });
                showToast('Consulta cancelada.', 'success');
                modalCancelarAgendamento.classList.remove('active');
                e.target.reset();
                agendamentoIdParaAtualizar = null;
                await carregarAgendamentos();
            } catch (error) {
                console.error("Erro ao cancelar consulta: ", error);
                showToast('Erro ao cancelar consulta.', 'error');
            }
        });
    });

    const agendaContainer = document.getElementById('agenda-professionals');
    if (agendaContainer) {
        agendaContainer.addEventListener('click', async (e) => {
            const btnRemoverBloqueio = e.target.closest('.btn-remover-bloqueio');
            if (btnRemoverBloqueio) {
                e.stopPropagation();
                if (await confirmarAcao('Deseja remover este bloqueio e liberar o horário?', { titulo: 'Remover bloqueio', textoConfirmar: 'Remover', perigoso: false })) {
                    const idBloqueio = btnRemoverBloqueio.getAttribute('data-id');
                    const bloqueioRemovido = clinicaState.agenda.bloqueios.find(b => String(b.id) === String(idBloqueio));
                    try {
                        await deleteDoc(doc(db, "bloqueios_agenda", idBloqueio));
                        showToast('Bloqueio removido.', 'success');
                        if (bloqueioRemovido) {
                            const profissional = clinicaState.profissionais.find(p => String(p.id) === String(bloqueioRemovido.profId));
                            await registrarAuditoria({
                                acao: 'Exclusão',
                                modulo: 'Agenda',
                                descricao: `Bloqueio removido: ${profissional ? profissional.nome : bloqueioRemovido.profId} em ${bloqueioRemovido.data}`
                            });
                        }
                        await carregarBloqueios();
                    } catch (error) {
                        console.error("Erro ao remover bloqueio: ", error);
                        showToast('Erro ao remover bloqueio.', 'error');
                    }
                }
            }
        });
    }

    // ==========================================
    // MODAL DE DETALHE DO AGENDAMENTO (aberto ao clicar num card
    // ocupado - ver abrirModalDetalheAgendamento). Reúne aqui a troca
    // de status, a confirmação de pagamento e o cancelamento, que
    // antes viviam soltos dentro do card na grade.
    // ==========================================
    const modalDetalhe = document.getElementById('modal-detalhe-agendamento');
    const selectStatusDetalhe = document.getElementById('detalhe-agendamento-status');
    const btnPagarDetalhe = document.getElementById('btn-confirmar-pagamento-detalhe');
    const btnCancelarDetalhe = document.getElementById('btn-cancelar-consulta-detalhe');
    const btnCloseDetalhe = document.getElementById('btn-close-detalhe-agendamento');

    if (btnCloseDetalhe) {
        btnCloseDetalhe.addEventListener('click', () => {
            modalDetalhe.classList.remove('active');
            agendamentoIdParaAtualizar = null;
        });
    }

    if (btnPagarDetalhe) {
        btnPagarDetalhe.addEventListener('click', () => {
            if (!agendamentoIdParaAtualizar) return;
            modalDetalhe.classList.remove('active');
            abrirModalPagamento(agendamentoIdParaAtualizar);
        });
    }

    if (btnCancelarDetalhe) {
        btnCancelarDetalhe.addEventListener('click', () => {
            if (!agendamentoIdParaAtualizar) return;
            modalDetalhe.classList.remove('active');
            document.getElementById('form-cancelar-agendamento').reset();
            modalCancelarAgendamento.classList.add('active');
        });
    }

    if (selectStatusDetalhe) {
        selectStatusDetalhe.addEventListener('change', async (e) => {
            if (!agendamentoIdParaAtualizar) return;
            const idAgendamento = agendamentoIdParaAtualizar;
            const novoStatus = e.target.value;

            if (novoStatus === 'confirmado') {
                const agendamento = clinicaState.agenda.agendamentos.find(a => String(a.id) === String(idAgendamento));
                if (agendamento && Number(agendamento.valorAtendimento || 0) > 0) {
                    await updateDoc(doc(db, "agendamentos", idAgendamento), { statusPagamento: 'pendente' });
                    modalDetalhe.classList.remove('active');
                    abrirModalPagamento(idAgendamento);
                    return;
                }

                document.getElementById('form-confirmar-agendamento').reset();
                modalDetalhe.classList.remove('active');
                modalConfirmarAgendamento.classList.add('active');
                return;
            }

            if (novoStatus === 'cancelado') {
                document.getElementById('form-cancelar-agendamento').reset();
                modalDetalhe.classList.remove('active');
                modalCancelarAgendamento.classList.add('active');
                return;
            }

            try {
                const agendamentoAtual = clinicaState.agenda.agendamentos.find(a => String(a.id) === String(idAgendamento));
                const valorConsulta = Number(agendamentoAtual?.valorAtendimento || 0);
                const proximoStatusPagamento = novoStatus === 'concluido' && valorConsulta > 0
                    ? 'pendente'
                    : agendamentoAtual?.statusPagamento || 'nao_aplica';

                await updateDoc(doc(db, "agendamentos", idAgendamento), {
                    status: novoStatus,
                    statusPagamento: valorConsulta > 0 ? proximoStatusPagamento : 'nao_aplica'
                });
                showToast('Status atualizado!', 'success');

                const idxAg = clinicaState.agenda.agendamentos.findIndex(a => String(a.id) === String(idAgendamento));
                if (idxAg >= 0) {
                    clinicaState.agenda.agendamentos[idxAg] = {
                        ...clinicaState.agenda.agendamentos[idxAg],
                        status: novoStatus,
                        statusPagamento: valorConsulta > 0 ? proximoStatusPagamento : 'nao_aplica'
                    };
                }

                if (novoStatus === 'concluido') {
                    const agendamentoConcluido = clinicaState.agenda.agendamentos.find(a => String(a.id) === String(idAgendamento));
                    if (agendamentoConcluido && Number(agendamentoConcluido.valorAtendimento || 0) > 0) {
                        modalDetalhe.classList.remove('active');
                        abrirModalPagamento(idAgendamento);
                        await criarNotificacao({
                            tipo: 'pagamento_pendente',
                            titulo: 'Confirmar pagamento',
                            mensagem: `A consulta de ${agendamentoConcluido.pacNome} (${agendamentoConcluido.procedimentoNome || agendamentoConcluido.tipo || 'Consulta'}) foi concluída.`,
                            pacienteId: agendamentoConcluido.pacId,
                            pacienteNome: agendamentoConcluido.pacNome
                        });
                    } else {
                        modalDetalhe.classList.remove('active');
                    }
                } else {
                    modalDetalhe.classList.remove('active');
                }

                agendamentoIdParaAtualizar = null;
                atualizarAgenda();
            } catch (error) {
                console.error("Erro ao atualizar status: ", error);
                showToast('Erro ao atualizar.', 'error');
            }
        });
    }

    const selectVisao = document.getElementById('agenda-visao');
    if (selectVisao) {
        selectVisao.addEventListener('change', atualizarAgenda);
    }

    // ==========================================
    // NOVO: ALTERNADOR DE PERÍODO E NAVEGAÇÃO DE DATA
    // ==========================================
    const toggle = document.getElementById('agenda-periodo-toggle');
    if (toggle) {
        toggle.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-periodo]');
            if (!btn) return;

            periodoAtual = btn.getAttribute('data-periodo');
            toggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));

            // A visão "Por Salas / Profissionais" e o filtro de profissional
            // só fazem sentido na visão de Dia (na semana/mês eles ficam
            // ocultos pra não sobrecarregar os controles).
            const selVisao = document.getElementById('agenda-visao');
            if (selVisao) selVisao.style.display = periodoAtual === 'dia' ? '' : 'none';

            atualizarAgenda();
        });
    }

    document.getElementById('btn-agenda-hoje')?.addEventListener('click', () => {
        inputDataAgenda.value = new Date().toISOString().split('T')[0];
        atualizarAgenda();
    });

    document.getElementById('btn-agenda-anterior')?.addEventListener('click', () => navegarData(-1));
    document.getElementById('btn-agenda-proximo')?.addEventListener('click', () => navegarData(1));
}

// Move a data de referência pra frente/trás de acordo com o período
// ativo: 1 dia, 1 semana ou 1 mês por clique.
function navegarData(direcao) {
    const inputDataAgenda = document.getElementById('data-agenda');
    const dataAtual = parseDataLocal(inputDataAgenda.value || new Date().toISOString().split('T')[0]);

    if (periodoAtual === 'dia') {
        dataAtual.setDate(dataAtual.getDate() + direcao);
    } else if (periodoAtual === 'semana') {
        dataAtual.setDate(dataAtual.getDate() + (direcao * 7));
    } else {
        dataAtual.setMonth(dataAtual.getMonth() + direcao);
    }

    inputDataAgenda.value = paraIsoDate(dataAtual);
    atualizarAgenda();
}

export function abrirModalAgendamento(hora = '', profId = '', data = '') {
    const modalAgenda = document.getElementById('modal-agendamento');
    const selPac = document.getElementById('agenda-paciente');
    const selProf = document.getElementById('agenda-profissional');
    const inputDataAgenda = document.getElementById('data-agenda');
    
    let profsPermitidos = clinicaState.profissionais;
    if (clinicaState.sessao.perfil === 'Doutor(a)') {
        profsPermitidos = clinicaState.profissionais.filter(p => p.nome.trim().toLowerCase() === clinicaState.sessao.nome.trim().toLowerCase());
    }

    selPac.innerHTML = clinicaState.pacientes.map(p => `<option value="${p.id}">${escapeHTML(p.nome)}</option>`).join('');
    selProf.innerHTML = profsPermitidos.map(p => `<option value="${p.id}">${escapeHTML(p.nome)} (${escapeHTML(p.especialidade)})</option>`).join('');
    
    if (clinicaState.sessao.perfil === 'Doutor(a)') {
        selProf.style.pointerEvents = 'none';
        selProf.style.backgroundColor = '#e2e8f0';
    } else {
        selProf.style.pointerEvents = 'auto';
        selProf.style.backgroundColor = '';
    }
    
    if(data) document.getElementById('agenda-data').value = data;
    else document.getElementById('agenda-data').value = inputDataAgenda.value;
    
    const inputHora = document.getElementById('agenda-hora');
    if(hora) inputHora.value = hora; 
    else inputHora.value = "08:00"; 
    
    if(profId) selProf.value = profId;

    const tipoAtendimento = document.getElementById('agenda-tipo');
    if (tipoAtendimento) {
        tipoAtendimento.value = 'procedimento_avulso';
    }

    popularSelectProcedimentos();
    document.getElementById('agenda-sala').value = '';
    atualizarDisponibilidadeSalas();
    atualizarVisualizacaoProcedimento();
    
    modalAgenda.classList.add('active');
}

function atualizarDisponibilidadeSalas() {
    const selectSala = document.getElementById('agenda-sala');
    if (!selectSala) return;

    const data = document.getElementById('agenda-data').value;
    const hora = document.getElementById('agenda-hora').value;

    const ocupadas = new Set(
        clinicaState.agenda.agendamentos
            .filter(a => a.data === data && a.hora === hora && a.status !== 'cancelado')
            .map(a => String(a.sala))
    );

    const valorAtual = selectSala.value;
    Array.from(selectSala.options).forEach(opt => {
        if (!opt.value) return; 
        const ocupada = ocupadas.has(opt.value);
        opt.disabled = ocupada;
        opt.textContent = ocupada ? `Sala ${opt.value} (ocupada)` : `Sala ${opt.value}`;
    });

    if (valorAtual && ocupadas.has(valorAtual)) selectSala.value = '';
}

export function abrirModalBloqueio() {
    const modalBloqueio = document.getElementById('modal-bloqueio');
    const selProf = document.getElementById('bloqueio-profissional');
    const inputDataAgenda = document.getElementById('data-agenda');

    let profsPermitidos = clinicaState.profissionais;
    if (clinicaState.sessao.perfil === 'Doutor(a)') {
        profsPermitidos = clinicaState.profissionais.filter(p => p.nome.trim().toLowerCase() === clinicaState.sessao.nome.trim().toLowerCase());
    }

    selProf.innerHTML = profsPermitidos.map(p => `<option value="${p.id}">${escapeHTML(p.nome)} (${escapeHTML(p.especialidade)})</option>`).join('');

    document.getElementById('bloqueio-data').value = inputDataAgenda.value;
    document.getElementById('bloqueio-tipo').value = 'dia_inteiro';
    document.getElementById('bloqueio-horario-especifico-group').style.display = 'none';

    modalBloqueio.classList.add('active');
}

export function atualizarAgenda() {
    const container = document.getElementById('agenda-professionals');
    const colHorarios = document.getElementById('time-column-slots');
    if (!container || !colHorarios) return;

    const inputDataAgenda = document.getElementById('data-agenda');
    const dataSelecionada = inputDataAgenda.value;
    const filtroProfissional = document.getElementById('filtro-profissional');
    const selectVisao = document.getElementById('agenda-visao');

    // === TRAVA DO DOUTOR: COLUNAS/FILTRO DA AGENDA (vale pra dia/semana/mês) ===
    let profsPermitidos = clinicaState.profissionais;
    let mostrarTodos = true;

    if (clinicaState.sessao.perfil === 'Doutor(a)') {
        profsPermitidos = clinicaState.profissionais.filter(p => p.nome.trim().toLowerCase() === clinicaState.sessao.nome.trim().toLowerCase());
        mostrarTodos = false;
        if (selectVisao) selectVisao.style.display = 'none';
    }

    let opcoesFiltro = '';
    if (mostrarTodos) opcoesFiltro += `<option value="todos">Todos os Profissionais</option>`;
    opcoesFiltro += profsPermitidos.map(p => `<option value="${p.id}">${escapeHTML(p.nome)}</option>`).join('');

    const valorAnterior = filtroProfissional.value;
    filtroProfissional.innerHTML = opcoesFiltro;
    if (mostrarTodos && valorAnterior) filtroProfissional.value = valorAnterior;

    // ==========================================
    // NOVO: ALTERNA QUAL VISÃO (Dia / Semana / Mês) FICA VISÍVEL
    // ==========================================
    const viewDia = document.getElementById('agenda-view-dia');
    const viewSemana = document.getElementById('agenda-view-semana');
    const viewMes = document.getElementById('agenda-view-mes');

    if (viewDia) viewDia.style.display = periodoAtual === 'dia' ? '' : 'none';
    if (viewSemana) viewSemana.style.display = periodoAtual === 'semana' ? '' : 'none';
    if (viewMes) viewMes.style.display = periodoAtual === 'mes' ? '' : 'none';

    // O select "Por Profissionais / Por Salas" só faz sentido na visão Dia
    if (selectVisao && clinicaState.sessao.perfil !== 'Doutor(a)') {
        selectVisao.style.display = periodoAtual === 'dia' ? '' : 'none';
    }

    atualizarRotuloPeriodo(dataSelecionada);

    if (periodoAtual === 'semana' || periodoAtual === 'mes') {
        // Nas visões de Semana/Mês o filtro de profissional continua útil
        // (a visão "Por Salas" é que não se aplica aqui, então some).
        filtroProfissional.style.display = '';

        if (periodoAtual === 'semana') renderizarVisaoSemana(dataSelecionada, filtroProfissional.value);
        else renderizarVisaoMes(dataSelecionada, filtroProfissional.value);
        return;
    }

    // ==========================================
    // A PARTIR DAQUI: VISÃO DIA (grade por hora, já existente)
    // ==========================================
    const visaoAtual = selectVisao ? selectVisao.value : 'profissionais';

    // === NOVO: HORÁRIOS DINÂMICOS ===
    const baseTimes = ['08:00', '09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
    const timesNoDia = new Set(baseTimes);

    clinicaState.agenda.agendamentos.forEach(a => {
        if (a.data === dataSelecionada) timesNoDia.add(a.hora);
    });
    clinicaState.agenda.bloqueios.forEach(b => {
        if (b.data === dataSelecionada && b.tipo === 'horario') {
            timesNoDia.add(b.horaInicio);
        }
    });

    const appointmentTimes = Array.from(timesNoDia).sort();

    colHorarios.innerHTML = `<div class="time-slot-header">Horário</div>` +
        appointmentTimes.map(h => `<div class="time-slot">${h}</div>`).join('');

    if (visaoAtual === 'salas') {
        filtroProfissional.style.display = 'none';
    } else {
        filtroProfissional.style.display = '';
    }

    container.innerHTML = '';
    
    // ==========================================
    // RENDERIZAÇÃO POR SALAS FÍSICAS
    // ==========================================
    if (visaoAtual === 'salas' && clinicaState.sessao.perfil !== 'Doutor(a)') {
        const salasFisicas = ['1', '2', '3'];
        
        salasFisicas.forEach(sala => {
            const coluna = document.createElement('div');
            coluna.className = 'professional-column';
            coluna.innerHTML = `<div class="prof-header"><strong>Sala ${sala}</strong><small>Consultório</small></div>`;
            
            appointmentTimes.forEach(hora => {
                const agendamento = clinicaState.agenda.agendamentos.find(a => 
                    String(a.sala) === sala && a.data === dataSelecionada && a.hora === hora && a.status !== 'cancelado'
                );
                
                const slot = document.createElement('div');
                if (agendamento) {
                    renderizarSlotOcupado(slot, agendamento);
                } else {
                    slot.className = 'appointment-slot empty';
                    slot.textContent = 'Sala Livre';
                    slot.addEventListener('click', () => {
                        abrirModalAgendamento(hora, '', dataSelecionada);
                        setTimeout(() => {
                            const selSala = document.getElementById('agenda-sala');
                            if (selSala) selSala.value = sala;
                        }, 50);
                    });
                }
                coluna.appendChild(slot);
            });
            container.appendChild(coluna);
        });
        return;
    }

    // ==========================================
    // RENDERIZAÇÃO POR PROFISSIONAIS (Padrão)
    // ==========================================
    let filtroAtual = filtroProfissional.value;
    const profsParaExibir = filtroAtual === 'todos' 
        ? profsPermitidos 
        : profsPermitidos.filter(p => p.id == filtroAtual);
        
    if (profsParaExibir.length === 0) {
        container.innerHTML = `
            <div class="professional-column empty-column">
                <div class="prof-header">
                    <strong>Sem Profissionais</strong>
                    <small>Seu usuário não está vinculado à lista de profissionais.</small>
                </div>
            </div>`;
        return;
    }
    
    profsParaExibir.forEach(prof => {
        const coluna = document.createElement('div');
        coluna.className = 'professional-column';
        coluna.innerHTML = `<div class="prof-header"><strong>${escapeHTML(prof.nome)}</strong><small>${escapeHTML(prof.especialidade)}</small></div>`;
        
        appointmentTimes.forEach(hora => {
            const agendamento = clinicaState.agenda.agendamentos.find(a => 
                a.profId == prof.id && a.data === dataSelecionada && a.hora === hora && a.status !== 'cancelado'
            );
            
            const slot = document.createElement('div');
            if (agendamento) {
                renderizarSlotOcupado(slot, agendamento);
            } else {
                const bloqueio = obterBloqueio(prof.id, dataSelecionada, hora);
                if (bloqueio) {
                    slot.className = 'appointment-slot blocked';
                    slot.innerHTML = `
                        <div class="appt-slot-header">
                            <span class="blocked-label"><i class="fa-solid fa-lock"></i> ${bloqueio.tipo === 'dia_inteiro' ? 'Folga (Dia Inteiro)' : 'Bloqueado'}</span>
                            <button class="appt-cancel-btn btn-remover-bloqueio" data-id="${bloqueio.id}" title="Remover bloqueio"><i class="fa-solid fa-xmark"></i></button>
                        </div>
                        ${bloqueio.motivo ? `<span class="appointment-type">${escapeHTML(bloqueio.motivo)}</span>` : ''}
                    `;
                } else {
                    slot.className = 'appointment-slot empty';
                    slot.textContent = 'Horário Livre';
                    slot.addEventListener('click', () => abrirModalAgendamento(hora, prof.id, dataSelecionada));
                }
            }
            coluna.appendChild(slot);
        });
        container.appendChild(coluna);
    });
}

// Atualiza o texto ao lado da navegação (< Hoje >) de acordo com o período ativo
function atualizarRotuloPeriodo(dataSelecionadaIso) {
    const label = document.getElementById('agenda-periodo-label');
    if (!label || !dataSelecionadaIso) return;

    const data = parseDataLocal(dataSelecionadaIso);

    if (periodoAtual === 'dia') {
        label.textContent = data.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
    } else if (periodoAtual === 'semana') {
        const domingo = obterDomingoDaSemana(data);
        const sabado = new Date(domingo);
        sabado.setDate(sabado.getDate() + 6);

        const mesmoMes = domingo.getMonth() === sabado.getMonth();
        const inicio = domingo.toLocaleDateString('pt-BR', { day: '2-digit', month: mesmoMes ? undefined : 'short' });
        const fim = sabado.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
        label.textContent = `${inicio} - ${fim}`;
    } else {
        label.textContent = `${NOMES_MES[data.getMonth()]} de ${data.getFullYear()}`;
    }
}

// Retorna os agendamentos (não cancelados) que o perfil logado pode ver,
// já aplicando a trava do Doutor(a) (só os próprios) e o filtro de
// profissional escolhido no select - usado pelas visões de Semana e Mês.
function agendamentosPermitidos(filtroProfId) {
    let profsPermitidos = clinicaState.profissionais;
    if (clinicaState.sessao.perfil === 'Doutor(a)') {
        profsPermitidos = clinicaState.profissionais.filter(p => p.nome.trim().toLowerCase() === clinicaState.sessao.nome.trim().toLowerCase());
    }
    const idsPermitidos = new Set(profsPermitidos.map(p => String(p.id)));

    return clinicaState.agenda.agendamentos.filter(a => {
        if (a.status === 'cancelado') return false;
        if (!idsPermitidos.has(String(a.profId))) return false;
        if (filtroProfId && filtroProfId !== 'todos' && String(a.profId) !== String(filtroProfId)) return false;
        return true;
    });
}

// ==========================================
// VISÃO SEMANA: 7 colunas (Dom a Sáb), cada uma com os agendamentos
// daquele dia empilhados em ordem de horário. Não reabre a grade de
// horário fixo (isso é papel da visão Dia) - aqui o foco é dar uma
// visão rápida da semana inteira sem médico/recepção precisar clicar
// dia a dia.
// ==========================================
function renderizarVisaoSemana(dataSelecionadaIso, filtroProfId) {
    const container = document.getElementById('agenda-view-semana');
    if (!container) return;

    const dataRef = parseDataLocal(dataSelecionadaIso);
    const domingo = obterDomingoDaSemana(dataRef);
    const hojeIso = paraIsoDate(new Date());

    const agendamentosDaSemana = agendamentosPermitidos(filtroProfId);

    container.innerHTML = '';

    for (let i = 0; i < 7; i++) {
        const diaAtual = new Date(domingo);
        diaAtual.setDate(diaAtual.getDate() + i);
        const diaIso = paraIsoDate(diaAtual);

        const coluna = document.createElement('div');
        coluna.className = 'week-day-column' + (diaIso === hojeIso ? ' is-today' : '');

        const doDia = agendamentosDaSemana
            .filter(a => a.data === diaIso)
            .sort((a, b) => (a.hora || '').localeCompare(b.hora || ''));

        coluna.innerHTML = `
            <div class="week-day-header">
                <span class="dow">${NOMES_DIA_SEMANA[diaAtual.getDay()]}</span>
                <span class="dnum">${diaAtual.getDate()}</span>
            </div>
            <div class="week-day-body">
                ${doDia.length === 0
                    ? '<div class="week-day-empty">Sem consultas</div>'
                    : doDia.map(a => {
                        const prof = clinicaState.profissionais.find(p => String(p.id) === String(a.profId));
                        return `
                        <div class="week-appt-chip" data-status="${a.status || 'agendado'}" data-id="${a.id}" title="${escapeHTML(a.pacNome)}">
                            <span class="chip-hora">${escapeHTML(a.hora)}</span>
                            <span class="chip-nome">${escapeHTML(a.pacNome)}</span>
                            <span class="chip-prof">${escapeHTML(prof ? prof.nome : '')}</span>
                        </div>`;
                    }).join('')
                }
            </div>
        `;

        coluna.querySelectorAll('.week-appt-chip').forEach(chip => {
            chip.addEventListener('click', () => abrirDetalheRapido(chip.getAttribute('data-id'), diaIso));
        });

        container.appendChild(coluna);
    }
}

// ==========================================
// VISÃO MÊS: calendário mensal clássico. Cada dia mostra até 3
// agendamentos (mini-etiquetas) e um "+N" se houver mais - clicar no
// dia leva direto pra visão Dia daquela data, que é onde de fato dá
// pra agir sobre os agendamentos (confirmar, cancelar etc.).
// ==========================================
function renderizarVisaoMes(dataSelecionadaIso, filtroProfId) {
    const grid = document.getElementById('agenda-month-grid');
    if (!grid) return;

    const dataRef = parseDataLocal(dataSelecionadaIso);
    const ano = dataRef.getFullYear();
    const mes = dataRef.getMonth();
    const hojeIso = paraIsoDate(new Date());

    const primeiroDiaDoMes = new Date(ano, mes, 1);
    const inicioGrade = obterDomingoDaSemana(primeiroDiaDoMes);

    const agendamentosDoPeriodo = agendamentosPermitidos(filtroProfId);
    const MAX_VISIVEIS = 3;

    grid.innerHTML = '';

    for (let i = 0; i < 42; i++) { // 6 semanas fixas, cobre qualquer mês
        const diaAtual = new Date(inicioGrade);
        diaAtual.setDate(diaAtual.getDate() + i);
        const diaIso = paraIsoDate(diaAtual);
        const foraDoMes = diaAtual.getMonth() !== mes;

        const doDia = agendamentosDoPeriodo
            .filter(a => a.data === diaIso)
            .sort((a, b) => (a.hora || '').localeCompare(b.hora || ''));

        const celula = document.createElement('div');
        celula.className = 'month-day-cell' + (foraDoMes ? ' outro-mes' : '') + (diaIso === hojeIso ? ' is-today' : '');

        const visiveis = doDia.slice(0, MAX_VISIVEIS);
        const restantes = doDia.length - visiveis.length;

        celula.innerHTML = `
            <span class="month-day-num">${diaAtual.getDate()}</span>
            <div class="month-day-dots">
                ${visiveis.map(a => `<span class="month-appt-dot" data-status="${a.status || 'agendado'}">${escapeHTML(a.hora)} ${escapeHTML(a.pacNome)}</span>`).join('')}
                ${restantes > 0 ? `<span class="month-day-mais">+${restantes} mais</span>` : ''}
            </div>
        `;

        celula.addEventListener('click', () => {
            periodoAtual = 'dia';
            document.querySelectorAll('#agenda-periodo-toggle button').forEach(b => b.classList.toggle('active', b.getAttribute('data-periodo') === 'dia'));
            const selVisao = document.getElementById('agenda-visao');
            if (selVisao && clinicaState.sessao.perfil !== 'Doutor(a)') selVisao.style.display = '';
            document.getElementById('data-agenda').value = diaIso;
            atualizarAgenda();
        });

        grid.appendChild(celula);
    }
}

// Ao clicar num agendamento resumido na visão Semana, a forma mais segura
// de agir sobre ele (confirmar, cancelar, marcar pagamento) continua sendo
// a visão Dia - que já tem toda a lógica de status/pagamento pronta. Então
// só pulamos pra lá, já no dia certo, em vez de duplicar essas ações aqui.
function abrirDetalheRapido(idAgendamento, diaIso) {
    periodoAtual = 'dia';
    document.querySelectorAll('#agenda-periodo-toggle button').forEach(b => b.classList.toggle('active', b.getAttribute('data-periodo') === 'dia'));
    const selVisao = document.getElementById('agenda-visao');
    if (selVisao && clinicaState.sessao.perfil !== 'Doutor(a)') selVisao.style.display = '';
    document.getElementById('data-agenda').value = diaIso;
    atualizarAgenda();
}

// Extraí a renderização do card ocupado para não duplicar código entre as duas visões
function renderizarSlotOcupado(slot, agendamento) {
    const statusAtual = agendamento.status || 'agendado';
    slot.className = 'appointment-slot occupied';
    slot.dataset.status = statusAtual;
    slot.dataset.id = agendamento.id;

    const nomeAtendimento = agendamento.procedimentoNome || agendamento.tipo || 'Consulta';
    const pagamentoPendente = Number(agendamento.valorAtendimento || 0) > 0 && agendamento.statusPagamento !== 'pago' && agendamento.statusPagamento !== 'nao_aplica';

    const selectVisao = document.getElementById('agenda-visao');
    const mostrarProfissional = selectVisao && selectVisao.value === 'salas';
    const nomeProfissional = mostrarProfissional ? clinicaState.profissionais.find(p => String(p.id) === String(agendamento.profId))?.nome || 'Profissional' : '';

    // Card enxuto: só o essencial pra reconhecer a consulta na grade.
    // Sala, valor, forma de pagamento e troca de status ficam no modal
    // de detalhe (aberto ao clicar) - ver abrirModalDetalheAgendamento().
    slot.innerHTML = `
        <p class="appt-card-nome" title="${escapeHTML(agendamento.pacNome)}">${escapeHTML(agendamento.pacNome)}</p>
        <span class="appt-card-tipo">${escapeHTML(nomeAtendimento)}${mostrarProfissional ? ` · ${escapeHTML(nomeProfissional)}` : ''}</span>
        ${pagamentoPendente ? '<span class="appt-card-pendencia"><i class="fa-solid fa-hand-holding-dollar"></i> Pagamento pendente</span>' : ''}
    `;

    slot.addEventListener('click', () => abrirModalDetalheAgendamento(agendamento.id));
}

// ========================================================
// MODAL DE DETALHE DO AGENDAMENTO
// Concentra tudo que antes ficava espremido dentro do card da
// grade: tipo, profissional, sala, valor, forma/status de
// pagamento, troca de status e ação de cancelar. O card na
// grade agora só precisa mostrar paciente + tipo (ver
// renderizarSlotOcupado acima).
// ========================================================
function abrirModalDetalheAgendamento(idAgendamento) {
    const modal = document.getElementById('modal-detalhe-agendamento');
    const agendamento = clinicaState.agenda.agendamentos.find(a => String(a.id) === String(idAgendamento));
    if (!modal || !agendamento) return;

    agendamentoIdParaAtualizar = idAgendamento;

    const profissional = clinicaState.profissionais.find(p => String(p.id) === String(agendamento.profId));
    const nomeAtendimento = agendamento.procedimentoNome || agendamento.tipo || 'Consulta';
    const dataFormatada = agendamento.data ? `${agendamento.data.split('-').reverse().join('/')} às ${agendamento.hora || ''}` : '';

    const BADGE_PAGAMENTO = {
        pago: '💰 Pago',
        pendente: '⏳ Pendente',
        nao_aplica: 'Pacote / sem cobrança'
    };

    document.getElementById('detalhe-agendamento-titulo').textContent = agendamento.pacNome || 'Consulta';
    document.getElementById('detalhe-agendamento-info').innerHTML = `
        <div class="detalhe-info-row"><span class="rotulo">Atendimento</span><span class="valor">${escapeHTML(nomeAtendimento)}</span></div>
        <div class="detalhe-info-row"><span class="rotulo">Profissional</span><span class="valor">${escapeHTML(profissional ? profissional.nome : '-')}</span></div>
        <div class="detalhe-info-row"><span class="rotulo">Data / Horário</span><span class="valor">${escapeHTML(dataFormatada)}</span></div>
        <div class="detalhe-info-row"><span class="rotulo">Sala</span><span class="valor">${agendamento.sala ? escapeHTML(agendamento.sala) : '-'}</span></div>
        <div class="detalhe-info-row"><span class="rotulo">Valor</span><span class="valor">${agendamento.valorAtendimento ? formatCurrency(agendamento.valorAtendimento) : '-'}</span></div>
        <div class="detalhe-info-row"><span class="rotulo">Pagamento</span><span class="valor">${BADGE_PAGAMENTO[agendamento.statusPagamento] || '-'}</span></div>
    `;

    const selectStatus = document.getElementById('detalhe-agendamento-status');
    if (selectStatus) selectStatus.value = agendamento.status || 'agendado';

    const pagamentoPendente = Number(agendamento.valorAtendimento || 0) > 0 && agendamento.statusPagamento !== 'pago' && agendamento.statusPagamento !== 'nao_aplica';
    const btnPagar = document.getElementById('btn-confirmar-pagamento-detalhe');
    if (btnPagar) btnPagar.style.display = pagamentoPendente ? 'block' : 'none';

    const btnCancelar = document.getElementById('btn-cancelar-consulta-detalhe');
    if (btnCancelar) btnCancelar.style.display = agendamento.status === 'cancelado' ? 'none' : 'block';

    modal.classList.add('active');
}

export async function carregarBloqueios() {
    try {
        const q = query(
            collection(db, "bloqueios_agenda"),
            where("clinicaId", "==", clinicaState.sessao.clinicaId)
        );
        const querySnapshot = await getDocs(q);

        clinicaState.agenda.bloqueios = [];

        querySnapshot.forEach((doc) => {
            clinicaState.agenda.bloqueios.push({
                ...doc.data(),
                id: String(doc.id)
            });
        });

        atualizarAgenda();

    } catch (error) {
        console.error("Erro ao buscar bloqueios da agenda: ", error);
        showToast('Erro ao carregar bloqueios de horário.', 'error');
    }
}
export async function carregarAgendamentos() {
    try {
        const q = query(
            collection(db, "agendamentos"), 
            where("clinicaId", "==", clinicaState.sessao.clinicaId)
        );
        const querySnapshot = await getDocs(q);
        
        clinicaState.agenda.agendamentos = [];
                  
        querySnapshot.forEach((doc) => {
            clinicaState.agenda.agendamentos.push({
                ...doc.data(),
                id: String(doc.id) 
            });
        });
        
        atualizarAgenda(); 
             
    } catch (error) {
        console.error("Erro ao buscar agenda: ", error);
        showToast('Erro ao carregar agendamentos.', 'error');
    }
}