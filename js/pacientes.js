import { clinicaState } from './state.js';
import { showToast, escapeHTML, encriptar, decriptar, comEstadoDeCarregamento, confirmarAcao } from './Ferramentas.js';
import { atualizarAgenda } from './agenda.js';
import { criarNotificacao } from './notificacoes.js';

import { db } from './firebase.js';
import { collection, addDoc, getDocs, doc, updateDoc, deleteDoc, query, where, arrayUnion } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { registrarAuditoria } from './auditoria.js';
import { resetarSeletorModelo } from './modelosDocumentos.js';
import { obterHTMLDocumento, tituloDoDocumento } from './editorDocumento.js';
import { aoAbrirProntuarioAtendimento, aoFecharProntuarioAtendimento, lerCronometro, camposParaLiberarTrava, aoSalvarAtendimento, pacienteEmAtendimentoAgora, descreverTrava, formatarDuracaoCurta } from './atendimento.js';
import { initProntuarioExtras, aoAbrirProntuario, aoFecharProntuario, aoSalvarEvolucao, montarTextoEvolucao, lerSinaisVitais, validarSinaisVitais, calcularIdade } from './prontuario.js';

let pacienteAtivoId = null;
let pacienteEmEdicaoId = null; 
let anexosEmEdicao = null;
let anexosParaExcluirDoStorage = [];

function ajustarBlocosOpcionais() {
    document.querySelectorAll('#form-cadastro details.bloco-opcional').forEach(bloco => {
        bloco.open = Array.from(bloco.querySelectorAll('input:not([type="file"]), select, textarea'))
            .some(campo => campo.value && campo.value.trim() !== '');
    });
}

// ==========================================
// PACOTE DR. AROLDO: AUXILIARES DE EVOLUÇÃO
// ==========================================
function evolucaoEditavelHoje(evo) {
    const hoje = new Date();
    if (evo.dataISO) {
        const d = new Date(evo.dataISO);
        if (!Number.isNaN(d.getTime())) {
            return d.getFullYear() === hoje.getFullYear()
                && d.getMonth() === hoje.getMonth()
                && d.getDate() === hoje.getDate();
        }
    }
    const prefixoHoje = hoje.toLocaleDateString('pt-BR');
    return String(evo.data || '').startsWith(prefixoHoje);
}

function sairModoEdicaoEvolucao() {
    const editIdx = document.getElementById('pep-evo-edit-index');
    if (editIdx) editIdx.value = '';
    const badge = document.getElementById('pep-evo-editando-badge');
    if (badge) badge.style.display = 'none';
    const btnCancel = document.getElementById('btn-cancelar-edicao-evo');
    if (btnCancel) btnCancel.style.display = 'none';
    const btnSubmit = document.getElementById('btn-submit-evolucao');
    if (btnSubmit) btnSubmit.innerHTML = '<i class="fa-solid fa-signature"></i> Assinar e Salvar no Histórico';
}

function montarBlocoOftalmologia() {
    const avOd = document.getElementById('pep-oft-av-od')?.value.trim() || '';
    const avOe = document.getElementById('pep-oft-av-oe')?.value.trim() || '';
    const refOd = document.getElementById('pep-oft-ref-od')?.value.trim() || '';
    const refOe = document.getElementById('pep-oft-ref-oe')?.value.trim() || '';
    const bio = document.getElementById('pep-oft-bio')?.value.trim() || '';

    const linhas = [];
    if (avOd || avOe) linhas.push(`**Acuidade Visual:** OD: ${avOd || '-'} | OE: ${avOe || '-'}`);
    if (refOd || refOe) linhas.push(`**Refração:** OD: ${refOd || '-'} | OE: ${refOe || '-'}`);
    if (bio) linhas.push(`**Biomicroscopia / FO / PIO:** ${bio}`);
    return linhas.join('\n');
}

export function initPacientes() {
    const modalCadastro = document.getElementById('modal-cadastro');
    const tipoCadastro = document.getElementById('tipo-cadastro');

    window.addEventListener('afterprint', () => document.body.removeAttribute('data-impressao'));

    initProntuarioExtras();

    // ==========================================
    // CONTROLADORES DO PACOTE DR. AROLDO
    // ==========================================
    const selModeloEvo = document.getElementById('pep-modelo-evolucao-select');
    const btnSalvarModeloEvo = document.getElementById('btn-salvar-modelo-evolucao');
    const btnModoLivre = document.getElementById('btn-alternar-modo-livre');
    const blocoEstruturado = document.getElementById('pep-bloco-estruturado');
    const btnCancelarEdicaoEvo = document.getElementById('btn-cancelar-edicao-evo');

    const MODELOS_PADRAO_EVOLUCAO = [
        {
            titulo: 'Oftalmologia — Consulta de Retina (Dr. Aroldo)',
            queixa: 'Avaliação de Retina',
            anamnese: 'ACM: Nega | AOP: Nega | HF Glaucoma: Nega',
            exame: 'BIO AO: Olho calmo, CAF, pupilas isofotorreagentes, SRCA.\nFO AO: D.O. com contorno regular, vasos retinianos sem tortuosidade, vítreo transparente, retina aplicada, mácula livre.',
            conduta: 'Oriento retorno anual e sinais de alarme.'
        },
        {
            titulo: 'Oftalmologia — Consulta Oftalmológica Geral / Refração',
            queixa: 'Revisão visual e refração',
            anamnese: 'Paciente refere dificuldade visual progressiva para longe/perto.',
            exame: 'BIO AO: Córnea clara, câmara anterior formada, cristalino transparente.\nFO AO: Papila fisiológica, mácula sem alterações.',
            conduta: 'Prescrição de correção óptica e lubrificante ocular.'
        },
        {
            titulo: 'Terapia Ocupacional — Evolução Sessão TEA / TDAH',
            queixa: 'Sessão de Terapia Ocupacional',
            anamnese: 'Criança comparece acompanhada pelo responsável, receptiva ao setting terapêutico.',
            exame: 'Trabalhadas habilidades de integração sensorial, coordenação motora fina, práxis e autorregulação.',
            conduta: 'Mantido plano terapêutico semanal e orientações à família.'
        },
        {
            titulo: 'Psicologia — Sessão de Psicoterapia / ABA',
            queixa: 'Acompanhamento Psicológico',
            anamnese: 'Sessão focada em manejo comportamental, comunicação funcional e habilidades sociais.',
            exame: 'Paciente colaborativo durante as intervenções propostas.',
            conduta: 'Seguimento conforme plano multidisciplinar.'
        }
    ];

    function atualizarListaModelosEvolucao() {
        if (!selModeloEvo) return;
        const salvos = JSON.parse(localStorage.getItem('vitalis_modelos_evolucao') || '[]');
        const todos = [...MODELOS_PADRAO_EVOLUCAO, ...salvos];
        selModeloEvo.innerHTML = '<option value="">📋 Carregar modelo de evolução (Ex: Consulta Retina, T.O., Pediatria)...</option>' +
            todos.map((m, i) => `<option value="${i}">${escapeHTML(m.titulo)}</option>`).join('');
    }
    atualizarListaModelosEvolucao();

    selModeloEvo?.addEventListener('change', () => {
        const idx = selModeloEvo.value;
        if (idx === '') return;
        const salvos = JSON.parse(localStorage.getItem('vitalis_modelos_evolucao') || '[]');
        const m = [...MODELOS_PADRAO_EVOLUCAO, ...salvos][Number(idx)];
        if (!m) return;
        const elQueixa = document.getElementById('pep-queixa');
        const elAnamnese = document.getElementById('pep-anamnese');
        const elExame = document.getElementById('pep-exame-fisico');
        const elPresc = document.getElementById('pep-prescricao');
        if (elQueixa) elQueixa.value = m.queixa || '';
        if (elAnamnese) elAnamnese.value = m.anamnese || '';
        if (elExame) elExame.value = m.exame || '';
        if (elPresc) elPresc.value = m.conduta || '';
        showToast(`Modelo "${m.titulo}" aplicado!`, 'info');
    });

    btnSalvarModeloEvo?.addEventListener('click', () => {
        const nome = prompt('Digite o nome para salvar este modelo de evolução (Ex: Consulta Catarata):');
        if (!nome || !nome.trim()) return;
        const salvos = JSON.parse(localStorage.getItem('vitalis_modelos_evolucao') || '[]');
        salvos.push({
            titulo: nome.trim(),
            queixa: document.getElementById('pep-queixa')?.value || '',
            anamnese: document.getElementById('pep-anamnese')?.value || '',
            exame: document.getElementById('pep-exame-fisico')?.value || '',
            conduta: document.getElementById('pep-prescricao')?.value || ''
        });
        localStorage.setItem('vitalis_modelos_evolucao', JSON.stringify(salvos));
        atualizarListaModelosEvolucao();
        showToast('Modelo de evolução salvo com sucesso!', 'success');
    });

    btnModoLivre?.addEventListener('click', () => {
        if (!blocoEstruturado) return;
        const livreAtivo = blocoEstruturado.style.display === 'none';
        blocoEstruturado.style.display = livreAtivo ? 'grid' : 'none';
        ['pep-queixa', 'pep-anamnese', 'pep-exame-fisico'].forEach(id => {
            const c = document.getElementById(id);
            if (!c) return;
            if (!livreAtivo) {
                if (!c.value) c.value = 'Registro em modo livre';
                c.removeAttribute('required');
            } else {
                if (c.value === 'Registro em modo livre') c.value = '';
            }
        });
        btnModoLivre.innerHTML = livreAtivo
            ? '<i class="fa-solid fa-align-left"></i> Modo Texto Livre'
            : '<i class="fa-solid fa-list-check"></i> Voltar ao Modo Estruturado';
    });

    btnCancelarEdicaoEvo?.addEventListener('click', () => {
        sairModoEdicaoEvolucao();
        document.getElementById('form-evolucao')?.reset();
        showToast('Edição de evolução cancelada.', 'info');
    });

    document.getElementById('btn-abrir-memed')?.addEventListener('click', () => {
        window.open('https://memed.com.br/', '_blank', 'noopener');
        showToast('Abrindo plataforma de Prescrição Digital Memed (ICP-Brasil)...', 'info');
    });

    // Clique em Editar ou Excluir evolução do mesmo dia (até 23:59) ou abrir anexo do PEP
    document.getElementById('prontuario-ativo')?.addEventListener('click', async (e) => {
        const btnVerAnexoPep = e.target.closest('.btn-abrir-anexo-pep');
        if (btnVerAnexoPep) {
            const paciente = clinicaState.pacientes.find(p => String(p.id) === String(pacienteAtivoId));
            if (!paciente || !paciente.anexos) return;
            const tipo = btnVerAnexoPep.getAttribute('data-tipo');
            if (tipo === 'documento') {
                abrirDocumentoEmNovaAba(obterUrlAnexo(paciente.anexos.documento), 'Documento de Identidade');
            } else if (tipo === 'outro') {
                const idx = parseInt(btnVerAnexoPep.getAttribute('data-idx') || '0', 10);
                abrirDocumentoEmNovaAba(obterUrlAnexo(paciente.anexos.outros?.[idx]), `Documento ${idx + 1}`);
            }
            return;
        }

        const btnEditEvo = e.target.closest('.btn-editar-evo-hoje');
        const btnDelEvo = e.target.closest('.btn-excluir-evo-hoje');
        if (!btnEditEvo && !btnDelEvo) return;

        const paciente = clinicaState.pacientes.find(p => String(p.id) === String(pacienteAtivoId));
        if (!paciente) return;
        const idx = Number((btnEditEvo || btnDelEvo).getAttribute('data-idx'));
        const evo = paciente.evolucoes?.[idx];
        if (!evo || !evolucaoEditavelHoje(evo)) {
            showToast('Esta evolução já passou da meia-noite e está bloqueada para alterações.', 'error');
            return;
        }

        if (btnDelEvo) {
            const confirmar = await confirmarAcao(
                'Deseja remover esta evolução registrada hoje (ex: lançada no paciente errado)? Após a meia-noite isso não será mais possível.',
                { titulo: 'Excluir evolução de hoje', textoConfirmar: 'Excluir evolução' }
            );
            if (!confirmar) return;
            paciente.evolucoes.splice(idx, 1);
            await updateDoc(doc(db, 'pacientes', paciente.id), { evolucoes: paciente.evolucoes });
            await registrarAuditoria({ acao: 'Exclusão', modulo: 'Prontuário', descricao: `Evolução do mesmo dia removida de ${paciente.nome}` });
            renderizarEvolucoes(paciente);
            renderizarResumoRapidoProntuario(paciente);
            showToast('Evolução removida com sucesso.', 'success');
            return;
        }

        if (btnEditEvo) {
            const texto = decriptar(evo.texto);
            const editIdx = document.getElementById('pep-evo-edit-index');
            if (editIdx) editIdx.value = String(idx);
            const badge = document.getElementById('pep-evo-editando-badge');
            if (badge) badge.style.display = 'inline-block';
            if (btnCancelarEdicaoEvo) btnCancelarEdicaoEvo.style.display = 'inline-flex';
            const btnSubmit = document.getElementById('btn-submit-evolucao');
            if (btnSubmit) btnSubmit.innerHTML = '<i class="fa-solid fa-pen-to-square"></i> Salvar Retificação de Hoje';

            const qp = extrairCampoEvolucao(texto, ['Queixa Principal']);
            const hda = extrairCampoEvolucao(texto, ['História da Doença Atual', 'Anamnese']);
            const ef = extrairCampoEvolucao(texto, ['Exame Físico']);
            const cidDiag = extrairCampoEvolucao(texto, ['Hipótese Diagnóstica', 'Suspeita Diagnóstica']);
            const cond = extrairCampoEvolucao(texto, ['Conduta e Prescrição', 'Conduta']);

            if (document.getElementById('pep-queixa')) document.getElementById('pep-queixa').value = qp || 'Retificação no mesmo dia';
            if (document.getElementById('pep-anamnese')) document.getElementById('pep-anamnese').value = hda || texto;
            if (document.getElementById('pep-exame-fisico')) document.getElementById('pep-exame-fisico').value = ef || '-';
            if (document.getElementById('pep-cid') && evo.cid) document.getElementById('pep-cid').value = evo.cid;
            if (document.getElementById('pep-diagnostico') && cidDiag) document.getElementById('pep-diagnostico').value = cidDiag;
            if (document.getElementById('pep-prescricao')) document.getElementById('pep-prescricao').value = cond || texto;

            document.querySelector('.tab-btn[data-tab="tab-evolucao"]')?.click();
            document.getElementById('pep-prescricao')?.focus();
            showToast('Modo de retificação ativado (permitido até 23:59 de hoje).', 'info');
        }
    });

    document.getElementById('btn-novo-paciente').addEventListener('click', () => {
        if (clinicaState.sessao.perfil === 'Doutor(a)') {
            showToast('Cadastro de paciente é restrito à Recepção e Administração.', 'error');
            return;
        }
        abrirModalCadastro('paciente');
    });
    document.getElementById('btn-novo-profissional').addEventListener('click', () => {
        if (clinicaState.sessao.perfil === 'Doutor(a)') {
            showToast('Gestão da equipe é restrita à Administração.', 'error');
            return;
        }
        abrirModalCadastro('profissional');
    });
    document.getElementById('btn-close-cadastro').addEventListener('click', () => { 
        modalCadastro.classList.remove('active');
        pacienteEmEdicaoId = null; 
    });

    function abrirModalCadastro(tipo) {
        document.getElementById('form-cadastro').reset();
        tipoCadastro.value = tipo;
        const isPac = tipo === 'paciente';

        anexosEmEdicao = { foto: null, documento: null, outros: [] };
        anexosParaExcluirDoStorage = [];
        renderizarAnexosExistentes();
        
        document.querySelectorAll('.paciente-only').forEach(el => el.style.display = isPac ? 'grid' : 'none');
        document.querySelectorAll('.profissional-only').forEach(el => el.style.display = !isPac ? 'grid' : 'none');
        
        if(isPac) {
            document.getElementById('step-verificacao-cpf').style.display = 'block';
            document.getElementById('step-dados-cadastrais').style.display = 'none';
        } else {
            document.getElementById('step-verificacao-cpf').style.display = 'none';
            document.getElementById('cad-cpf').removeAttribute('readonly');
            document.getElementById('cad-cpf').style.backgroundColor = '#fbfbfc';
            document.getElementById('step-dados-cadastrais').style.display = 'grid';
        }
        ajustarBlocosOpcionais();
        modalCadastro.classList.add('active');
    }

    tipoCadastro.addEventListener('change', (e) => abrirModalCadastro(e.target.value));

    const listaAnexosExistentes = document.getElementById('anexos-existentes-lista');
    if (listaAnexosExistentes) {
        listaAnexosExistentes.addEventListener('click', (e) => {
            const btnAbrirDoc = e.target.closest('.btn-abrir-doc-base64');
            if (btnAbrirDoc && anexosEmEdicao) {
                const tipo = btnAbrirDoc.getAttribute('data-tipo');
                if (tipo === 'foto') {
                    abrirDocumentoEmNovaAba(obterUrlAnexo(anexosEmEdicao.foto), 'Foto do Paciente');
                } else if (tipo === 'documento') {
                    abrirDocumentoEmNovaAba(obterUrlAnexo(anexosEmEdicao.documento), 'Documento de Identidade');
                } else if (tipo === 'outro') {
                    const idx = parseInt(btnAbrirDoc.getAttribute('data-idx'), 10);
                    const item = anexosEmEdicao.outros[idx];
                    if (item) abrirDocumentoEmNovaAba(obterUrlAnexo(item), `Documento ${idx + 1}`);
                }
                return;
            }

            const btn = e.target.closest('.btn-remover-anexo');
            if (!btn || !anexosEmEdicao) return;

            const tipo = btn.getAttribute('data-tipo');
            if (tipo === 'foto' && anexosEmEdicao.foto) {
                anexosParaExcluirDoStorage.push(anexosEmEdicao.foto);
                anexosEmEdicao.foto = null;
            } else if (tipo === 'documento' && anexosEmEdicao.documento) {
                anexosParaExcluirDoStorage.push(anexosEmEdicao.documento);
                anexosEmEdicao.documento = null;
            } else if (tipo === 'outro') {
                const idx = parseInt(btn.getAttribute('data-idx'), 10);
                if (anexosEmEdicao.outros[idx]) {
                    anexosParaExcluirDoStorage.push(anexosEmEdicao.outros[idx]);
                    anexosEmEdicao.outros.splice(idx, 1);
                }
            }
            renderizarAnexosExistentes();
        });
    }

    document.getElementById('btn-verificar-cpf').addEventListener('click', () => {
        const cpfDigitado = document.getElementById('cad-cpf-check').value.trim();
        if(!cpfDigitado) return showToast('Por favor, digite o CPF para verificação.', 'warning');
        
        const pacienteExistente = clinicaState.pacientes.find(p => p.cpf === cpfDigitado);
        if(pacienteExistente) {
            showToast(`Paciente já cadastrado: ${pacienteExistente.nome}. Abrindo prontuário...`, 'warning');
            modalCadastro.classList.remove('active');
            abrirProntuario(pacienteExistente.id);
        } else {
            document.getElementById('cad-cpf').value = cpfDigitado;
            document.getElementById('step-verificacao-cpf').style.display = 'none';
            document.getElementById('step-dados-cadastrais').style.display = 'grid';
            showToast('CPF liberado para novo cadastro.', 'success');
        }
    });

    // ==========================================
    // SALVAMENTO DE CADASTRO COM CRIPTOGRAFIA + ANEXOS BASE64
    // ==========================================
    document.getElementById('form-cadastro').addEventListener('submit', async (e) => {
        e.preventDefault();
        const tipo = tipoCadastro.value;

        if (tipo === 'profissional') {
            const conselho = document.getElementById('cad-conselho').value.trim();
            const registro = document.getElementById('cad-num-registro').value.trim();
            if (!conselho || !registro) {
                showToast('O Conselho (ex: CRM) e o Registro são obrigatórios por lei!', 'warning');
                return; 
            }
        }

        const btnSalvar = e.target.querySelector('button[type="submit"]');

        await comEstadoDeCarregamento(btnSalvar, 'Salvando...', async () => {
            const baseData = {
                nome: encriptar(document.getElementById('cad-nome').value),
                cpf: encriptar(document.getElementById('cad-cpf').value),
                rg: encriptar(document.getElementById('cad-rg').value),
                nascimento: encriptar(document.getElementById('cad-nascimento').value),
                mae: encriptar(document.getElementById('cad-mae').value),
                telefone: encriptar(document.getElementById('cad-tel').value),
                email: encriptar(document.getElementById('cad-email').value),
                dataCadastro: new Date().toISOString(),
                clinicaId: clinicaState.sessao.clinicaId 
            };

            try {
                if (tipo === 'paciente') {
                    const inputFoto = document.getElementById('cad-anexo-foto');
                    const inputDocumento = document.getElementById('cad-anexo-documento');
                    const inputOutros = document.getElementById('cad-anexo-outros');

                    let novaFotoUrl = null;
                    let novoDocumentoUrl = null;
                    const novosOutrosUrls = [];

                    try {
                        if (inputFoto?.files[0]) novaFotoUrl = await uploadAnexo(inputFoto.files[0], 'foto');
                        if (inputDocumento?.files[0]) novoDocumentoUrl = await uploadAnexo(inputDocumento.files[0], 'documento');
                        if (inputOutros?.files) {
                            for (const arquivo of Array.from(inputOutros.files).slice(0, 2)) {
                                novosOutrosUrls.push(await uploadAnexo(arquivo, 'outros'));
                            }
                        }
                    } catch (uploadError) {
                        console.error("Erro ao processar anexo: ", uploadError);
                        showToast(uploadError.message || 'Falha ao processar um dos anexos (use imagem JPG/PNG).', 'error');
                        return;
                    }

                    const anexosAtuais = {
                        foto: novaFotoUrl || (anexosEmEdicao ? anexosEmEdicao.foto : null),
                        documento: novoDocumentoUrl || (anexosEmEdicao ? anexosEmEdicao.documento : null),
                        outros: [...(anexosEmEdicao ? anexosEmEdicao.outros : []), ...novosOutrosUrls]
                    };
                    const houveMudancaDeAnexo = novaFotoUrl || novoDocumentoUrl || novosOutrosUrls.length > 0 || anexosParaExcluirDoStorage.length > 0;

                    const dadosParaSalvar = {
                        ...baseData,
                        sangue: encriptar(document.getElementById('cad-sangue').value),
                        alergias: encriptar(document.getElementById('cad-alergias').value),
                        convenio: encriptar(document.getElementById('cad-convenio').value || 'Particular'),
                        carteirinha: encriptar(document.getElementById('cad-carteirinha').value),
                        emergencia: encriptar(document.getElementById('cad-emergencia').value),
                        responsavel: encriptar(document.getElementById('cad-responsavel').value),
                        anexos: anexosAtuais
                    };

                    const nomeClaro = document.getElementById('cad-nome').value;
                    const sufixoAuditoria = houveMudancaDeAnexo ? ' (anexos atualizados)' : '';

                    if (pacienteEmEdicaoId) {
                        await updateDoc(doc(db, "pacientes", pacienteEmEdicaoId), dadosParaSalvar);
                        showToast('Dados do paciente atualizados!', 'success');
                        await registrarAuditoria({ acao: 'Edição', modulo: 'Pacientes', descricao: `Cadastro atualizado: ${nomeClaro}${sufixoAuditoria}` });
                    } else {
                        dadosParaSalvar.evolucoes = [];
                        await addDoc(collection(db, "pacientes"), dadosParaSalvar);
                        showToast('Paciente salvo e criptografado com sucesso!', 'success');
                        await registrarAuditoria({ acao: 'Criação', modulo: 'Pacientes', descricao: `Novo paciente cadastrado: ${nomeClaro}${sufixoAuditoria}` });
                    }
                } else {
                    const nomeClaro = document.getElementById('cad-nome').value;
                    await addDoc(collection(db, "profissionais"), {
                        ...baseData,
                        conselho: encriptar(document.getElementById('cad-conselho').value),
                        registro: encriptar(document.getElementById('cad-num-registro').value),
                        especialidade: encriptar(document.getElementById('cad-especialidade').value),
                        rqe: encriptar(document.getElementById('cad-rqe').value),
                        vinculo: encriptar(document.getElementById('cad-vinculo').value)
                    });
                    showToast('Profissional salvo e criptografado com sucesso!', 'success');
                    await registrarAuditoria({ acao: 'Criação', modulo: 'Profissionais', descricao: `Novo profissional cadastrado: ${nomeClaro}` });
                }

                modalCadastro.classList.remove('active');
                e.target.reset();
                pacienteEmEdicaoId = null; 
                anexosEmEdicao = { foto: null, documento: null, outros: [] };
                anexosParaExcluirDoStorage = [];
                renderizarAnexosExistentes();
                
                await carregarPacientes(); 
                await carregarProfissionais();

            } catch (error) {
                console.error("Erro ao salvar no Firestore: ", error);
                showToast('Erro de conexão ao salvar os dados.', 'error');
            }
        });
    });

    document.getElementById('btn-fechar-pep').addEventListener('click', () => {
        document.getElementById('prontuario-ativo').style.display = 'none';
        const listaContainer = document.getElementById('lista-pacientes-container');
        if (listaContainer) listaContainer.style.display = 'block';
        sairModoEdicaoEvolucao();
        aoFecharProntuario();
        aoFecharProntuarioAtendimento();
        pacienteAtivoId = null;
        renderizarResumoPacienteAtivo();
    });

    const btnImprimirPep = document.getElementById('btn-imprimir-pep');
    if (btnImprimirPep) {
        btnImprimirPep.addEventListener('click', () => {
            if (!pacienteAtivoId) return;
            const paciente = clinicaState.pacientes.find(p => String(p.id) === String(pacienteAtivoId));
            if (!paciente) return;

            const dataNasc = paciente.nascimento ? paciente.nascimento.split('-').reverse().join('/') : 'Não inf.';
            document.getElementById('print-pep-nome').textContent = paciente.nome;
            document.getElementById('print-pep-dados').textContent = `CPF: ${paciente.cpf || 'Não inf.'} | Nasc: ${dataNasc} | Tel: ${paciente.telefone || 'Não inf.'}`;
            document.getElementById('print-pep-convenio').textContent = paciente.convenio || 'Particular';
            document.getElementById('print-pep-alergias').textContent = paciente.alergias || 'Nenhuma alergia registrada';
            document.getElementById('print-pep-data').textContent = new Date().toLocaleDateString('pt-BR');

            const ultimaEvolucao = (paciente.evolucoes || []).slice(-1)[0];
            const elConteudo = document.getElementById('print-pep-conteudo');
            const elAssinatura = document.getElementById('print-pep-assinatura');
            if (ultimaEvolucao) {
                const textoFormatado = escapeHTML(decriptar(ultimaEvolucao.texto))
                    .replace(/\n/g, '<br>')
                    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                elConteudo.innerHTML = textoFormatado;
                elAssinatura.textContent = `Última evolução: ${ultimaEvolucao.data} - ${ultimaEvolucao.assinatura}`;
            } else {
                elConteudo.textContent = 'Sem evoluções registradas ainda.';
                elAssinatura.textContent = '';
            }

            document.body.setAttribute('data-impressao', 'pep');
            window.print();
        });
    }

    // ==========================================
    // SALVAMENTO DE EVOLUÇÃO COM CRIPTOGRAFIA + VALIDAÇÃO CID + JANELA 24H
    // ==========================================
    document.getElementById('form-evolucao').addEventListener('submit', async (e) => {
        e.preventDefault();
        if(!pacienteAtivoId) return;
        
        const paciente = clinicaState.pacientes.find(p => String(p.id) === String(pacienteAtivoId));
        const btnSalvar = e.target.querySelector('button[type="submit"]');

        const cidValor = (document.getElementById('pep-cid')?.value || '').trim().toUpperCase();
        if (!cidValor || cidValor.length < 3) {
            showToast('Informe o CID-10 ou clique num dos botões de Suspeita / Rotina para finalizar.', 'warning');
            document.getElementById('pep-cid')?.focus();
            return;
        }

        const prescricaoVal = (document.getElementById('pep-prescricao')?.value || '').trim();
        if (!prescricaoVal) {
            showToast('Preencha a evolução / conduta clínica antes de assinar.', 'warning');
            document.getElementById('pep-prescricao')?.focus();
            return;
        }

        await comEstadoDeCarregamento(btnSalvar, 'Assinando...', async () => {
            const erroSinais = validarSinaisVitais();
            if (erroSinais) {
                showToast(erroSinais, 'warning');
                return;
            }
            const sinaisVitais = lerSinaisVitais();
            const concluirConsulta = Boolean(document.getElementById('pep-concluir-consulta')?.checked);

            let textoProntuario = montarTextoEvolucao();
            const blocoOftalmo = montarBlocoOftalmologia();
            if (blocoOftalmo) {
                textoProntuario += `\n${blocoOftalmo}`;
            }

            const textoCriptografado = encriptar(textoProntuario);

            const profId = document.getElementById('pep-profissional').value;
            const profissional = clinicaState.profissionais.find(p => String(p.id) === String(profId));
            
            if (!profissional) {
                showToast('Selecione um profissional para assinar a ficha.', 'warning');
                return;
            }

            const editIdxStr = document.getElementById('pep-evo-edit-index')?.value ?? '';
            const editandoMesmoDia = editIdxStr !== '' && paciente.evolucoes?.[Number(editIdxStr)];

            if (editandoMesmoDia) {
                const idx = Number(editIdxStr);
                const evoOriginal = paciente.evolucoes[idx];
                if (!evolucaoEditavelHoje(evoOriginal)) {
                    showToast('Prazo de edição encerrado (após meia-noite). Registre uma nova evolução.', 'error');
                    sairModoEdicaoEvolucao();
                    return;
                }

                paciente.evolucoes[idx] = {
                    ...evoOriginal,
                    cid: cidValor,
                    texto: textoCriptografado,
                    editadoEm: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
                    ...(sinaisVitais ? { vitaisCripto: encriptar(JSON.stringify(sinaisVitais)) } : {})
                };

                try {
                    await updateDoc(doc(db, "pacientes", paciente.id), { evolucoes: paciente.evolucoes });
                    renderizarEvolucoes(paciente);
                    renderizarResumoRapidoProntuario(paciente);
                    sairModoEdicaoEvolucao();
                    e.target.reset();
                    if (clinicaState.sessao.perfil === 'Doutor(a)') {
                        document.getElementById('pep-profissional').value = profId;
                    }
                    aoSalvarEvolucao(paciente);
                    showToast('Evolução de hoje retificada com sucesso!', 'success');
                    await registrarAuditoria({ acao: 'Edição', modulo: 'Prontuário', descricao: `Evolução do mesmo dia retificada para ${paciente.nome} por ${profissional.nome} (CID: ${cidValor})` });
                } catch (error) {
                    console.error("Erro ao retificar evolução: ", error);
                    showToast('Erro de conexão ao salvar retificação.', 'error');
                }
                return;
            }

            const novaEvolucao = {
                data: new Date().toLocaleString('pt-BR'),
                dataISO: new Date().toISOString(),
                cid: cidValor,
                texto: textoCriptografado,
                profissionalId: String(profissional.id),
                assinatura: `Assinado digitalmente por ${profissional.nome} | ${profissional.conselho}: ${profissional.registro}`
            };
            if (sinaisVitais) novaEvolucao.vitaisCripto = encriptar(JSON.stringify(sinaisVitais));

            const cronometro = lerCronometro(paciente.id);
            if (cronometro) Object.assign(novaEvolucao, cronometro);

            if (!paciente.evolucoes) paciente.evolucoes = [];
            paciente.evolucoes.push(novaEvolucao);

            const diasRetornoInput = document.getElementById('pep-retorno-dias').value;
            const dadosAtualizados = { evolucoes: arrayUnion(novaEvolucao), ...camposParaLiberarTrava(paciente.id) };

            if (diasRetornoInput) {
                const dataRetorno = new Date();
                dataRetorno.setDate(dataRetorno.getDate() + parseInt(diasRetornoInput));
                const isoRetorno = `${dataRetorno.getFullYear()}-${String(dataRetorno.getMonth() + 1).padStart(2, '0')}-${String(dataRetorno.getDate()).padStart(2, '0')}`;
                paciente.proximoRetorno = isoRetorno;
                dadosAtualizados.proximoRetorno = isoRetorno;
            }

            try {
                const pacienteRef = doc(db, "pacientes", paciente.id);
                await updateDoc(pacienteRef, dadosAtualizados);

                if (diasRetornoInput) {
                    const dataExibicao = paciente.proximoRetorno.split('-').reverse().join('/');
                    await criarNotificacao({
                        tipo: 'retorno_pendente',
                        titulo: `Agendar retorno: ${paciente.nome}`,
                        mensagem: `${profissional.nome} pediu retorno para ${dataExibicao} (em ${diasRetornoInput} dia(s)).`,
                        pacienteId: paciente.id,
                        pacienteNome: paciente.nome
                    });
                }
                
                renderizarEvolucoes(paciente);
                renderizarResumoRapidoProntuario(paciente);
                sairModoEdicaoEvolucao();
                e.target.reset(); 
                
                if (clinicaState.sessao.perfil === 'Doutor(a)') {
                    document.getElementById('pep-profissional').value = profId;
                }
                aoSalvarEvolucao(paciente);
                aoSalvarAtendimento(paciente);
                showToast('Evolução salva no Prontuário com sucesso!');
                if (concluirConsulta) {
                    const concluida = await concluirConsultaDeHoje(paciente, profissional);
                    if (concluida) showToast('Consulta marcada como concluída na agenda.', 'success');
                }
                await registrarAuditoria({ acao: 'Criação', modulo: 'Prontuário', descricao: `Evolução registrada para ${paciente.nome} por ${profissional.nome} (CID: ${cidValor})` });
            } catch (error) {
                console.error("Erro ao salvar evolução: ", error);
                showToast('Erro de permissão ou conexão ao salvar ficha. Verifique o firestore.rules.', 'error');
                paciente.evolucoes.pop(); 
            }
        });
    });

    // ==========================================
    // EXAMES SOLICITADOS
    // ==========================================
    const formExames = document.getElementById('form-exames-solicitados');
    if (formExames) {
        formExames.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!pacienteAtivoId) return;

            const paciente = clinicaState.pacientes.find(p => String(p.id) === String(pacienteAtivoId));
            const btnSalvar = e.target.querySelector('button[type="submit"]');

            const profId = document.getElementById('pep-profissional').value;
            const profissional = clinicaState.profissionais.find(p => String(p.id) === String(profId));
            if (!profissional) {
                showToast('Selecione o profissional responsável na aba "Atendimento" antes de solicitar exames.', 'warning');
                return;
            }

            const textareaExames = document.getElementById('pep-exames-lista');
            const exames = textareaExames.value.split('\n').map(l => l.trim()).filter(Boolean);
            if (exames.length === 0) {
                showToast('Liste ao menos um exame.', 'warning');
                return;
            }

            await comEstadoDeCarregamento(btnSalvar, 'Registrando...', async () => {
                const novaSolicitacao = {
                    data: new Date().toLocaleString('pt-BR'),
                    examesCripto: encriptar(exames.join('; ')),
                    profissional: profissional.nome
                };

                if (!paciente.examesSolicitados) paciente.examesSolicitados = [];
                paciente.examesSolicitados.push(novaSolicitacao);

                try {
                    await updateDoc(doc(db, "pacientes", paciente.id), { examesSolicitados: paciente.examesSolicitados });

                    await criarNotificacao({
                        tipo: 'exame_solicitado',
                        titulo: `Exame(s) solicitado(s): ${paciente.nome}`,
                        mensagem: `${profissional.nome} solicitou: ${exames.join(', ')}. Ofereça o agendamento ao paciente antes que ele saia da clínica.`,
                        pacienteId: paciente.id,
                        pacienteNome: paciente.nome
                    });

                    renderizarExamesSolicitados(paciente);
                    textareaExames.value = '';
                    showToast('Exame(s) registrado(s) e recepção notificada!', 'success');
                    await registrarAuditoria({ acao: 'Criação', modulo: 'Prontuário', descricao: `Exames solicitados para ${paciente.nome}: ${exames.join(', ')}` });
                } catch (error) {
                    console.error("Erro ao registrar exames solicitados: ", error);
                    showToast('Erro de conexão ao registrar exames.', 'error');
                    paciente.examesSolicitados.pop();
                }
            });
        });
    }

    // ==========================================
    // DELEGAÇÃO DE EVENTOS DAS TABELAS
    // ==========================================
    const patientListBody = document.getElementById('patient-table-body-list');
    if (patientListBody) {
        patientListBody.addEventListener('click', async (e) => {
            const btnAbrir = e.target.closest('.btn-abrir-prontuario');
            const btnEditar = e.target.closest('.btn-editar-paciente');
            const btnExcluir = e.target.closest('.btn-excluir-paciente');

            if (btnAbrir) abrirProntuario(btnAbrir.getAttribute('data-id'));

            if (btnEditar && clinicaState.sessao.perfil === 'Doutor(a)') {
                showToast('Edição de pacientes não permitida para este perfil.', 'error');
                return;
            }

            if (btnExcluir && clinicaState.sessao.perfil === 'Doutor(a)') {
                showToast('Exclusão de pacientes não permitida para este perfil.', 'error');
                return;
            }

            if (btnEditar || btnExcluir) {
                const idAlvo = (btnEditar || btnExcluir).getAttribute('data-id');
                const trava = await pacienteEmAtendimentoAgora(idAlvo);
                if (trava) {
                    if (clinicaState.sessao.perfil !== 'admin') {
                        showToast(`Paciente em atendimento com ${descreverTrava(trava)}. Edição bloqueada até o fim da consulta.`, 'warning');
                        return;
                    }
                    const seguir = await confirmarAcao(`Este paciente está em atendimento com ${descreverTrava(trava)}. Continuar mesmo assim?`, {
                        titulo: 'Paciente em atendimento', textoConfirmar: 'Continuar', perigoso: false
                    });
                    if (!seguir) return;
                }
            }

            if (btnExcluir) {
                const idPac = btnExcluir.getAttribute('data-id');
                if (await confirmarAcao('Deseja excluir permanentemente este paciente? Todo o histórico de prontuário será perdido.', { titulo: 'Excluir paciente', textoConfirmar: 'Excluir' })) {
                    const pacienteExcluido = clinicaState.pacientes.find(p => String(p.id) === String(idPac));
                    try {
                        await deleteDoc(doc(db, "pacientes", idPac));
                        showToast('Paciente excluído do sistema.', 'success');
                        await registrarAuditoria({ acao: 'Exclusão', modulo: 'Pacientes', descricao: `Paciente excluído: ${pacienteExcluido ? pacienteExcluido.nome : idPac}` });
                        await carregarPacientes();
                    } catch (error) {
                        showToast('Falha ao excluir paciente.', 'error');
                    }
                }
            }

            if (btnEditar) {
                const idPac = btnEditar.getAttribute('data-id');
                const paciente = clinicaState.pacientes.find(p => String(p.id) === String(idPac));
                if (paciente) {
                    pacienteEmEdicaoId = paciente.id; 
                    document.getElementById('tipo-cadastro').value = 'paciente';
                    abrirModalCadastro('paciente'); 
                    document.getElementById('step-verificacao-cpf').style.display = 'none';
                    document.getElementById('step-dados-cadastrais').style.display = 'grid';
                    
                    document.getElementById('cad-nome').value = paciente.nome;
                    document.getElementById('cad-cpf').value = paciente.cpf;
                    document.getElementById('cad-rg').value = paciente.rg || '';
                    document.getElementById('cad-nascimento').value = paciente.nascimento;
                    document.getElementById('cad-mae').value = paciente.mae || '';
                    document.getElementById('cad-tel').value = paciente.telefone;
                    document.getElementById('cad-email').value = paciente.email || '';
                    document.getElementById('cad-sangue').value = paciente.sangue || '';
                    document.getElementById('cad-alergias').value = paciente.alergias || '';
                    document.getElementById('cad-convenio').value = paciente.convenio || '';
                    document.getElementById('cad-carteirinha').value = paciente.carteirinha || '';
                    document.getElementById('cad-emergencia').value = paciente.emergencia || '';
                    document.getElementById('cad-responsavel').value = paciente.responsavel || '';

                    anexosEmEdicao = paciente.anexos
                        ? { foto: paciente.anexos.foto || null, documento: paciente.anexos.documento || null, outros: [...(paciente.anexos.outros || [])] }
                        : { foto: null, documento: null, outros: [] };
                    anexosParaExcluirDoStorage = [];
                    renderizarAnexosExistentes();
                    ajustarBlocosOpcionais();
                }
            }
        });
    }

    const profListBody = document.getElementById('prof-table-body-list');
    if (profListBody) {
        profListBody.addEventListener('click', async (e) => {
            const btn = e.target.closest('.btn-excluir-prof');
            if (btn) {
                const idProf = btn.getAttribute('data-id');
                if (await confirmarAcao('Deseja remover este profissional do sistema?', { titulo: 'Remover profissional', textoConfirmar: 'Remover' })) {
                    const profExcluido = clinicaState.profissionais.find(p => String(p.id) === String(idProf));
                    try {
                        await deleteDoc(doc(db, "profissionais", idProf));
                        showToast('Profissional removido.', 'success');
                        await registrarAuditoria({ acao: 'Exclusão', modulo: 'Profissionais', descricao: `Profissional removido: ${profExcluido ? profExcluido.nome : idProf}` });
                        await carregarProfissionais(); 
                    } catch(error) {
                        showToast('Falha ao remover profissional.', 'error');
                    }
                }
            }
        });
    }

    // ==========================================
    // ABAS DO PRONTUÁRIO
    // ==========================================
    const tabBtns = document.querySelectorAll('.tab-btn');
    if (tabBtns.length > 0) {
        tabBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                tabBtns.forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                e.currentTarget.classList.add('active');
                document.getElementById(e.currentTarget.getAttribute('data-tab')).classList.add('active');
            });
        });
    }

    // ==========================================
    // ENCAMINHAMENTO
    // ==========================================
    const selTipoDocumento = document.getElementById('tipo-documento-impressao');
    const grupoEspecialidade = document.getElementById('grupo-especialidade-encaminhamento');
    const selEspecialidade = document.getElementById('encaminhamento-especialidade');

    if (selTipoDocumento && grupoEspecialidade) {
        selTipoDocumento.addEventListener('change', (e) => {
            grupoEspecialidade.style.display = e.target.value === 'ENCAMINHAMENTO MÉDICO' ? 'block' : 'none';
        });
    }

    if (selEspecialidade) {
        selEspecialidade.addEventListener('change', (e) => {
            const paciente = clinicaState.pacientes.find(p => String(p.id) === String(pacienteAtivoId));
            const nomePaciente = paciente ? paciente.nome : '[paciente]';
            const especialidade = e.target.value;

            document.getElementById('texto-receita').value =
                `Encaminho o(a) paciente ${nomePaciente} para avaliação e acompanhamento com especialista em ${especialidade}, conforme quadro clínico apresentado nesta consulta.\n\nFico à disposição para maiores esclarecimentos.`;
        });
    }

    const btnImprimir = document.getElementById('btn-imprimir-receita');
    if (btnImprimir) {
        btnImprimir.addEventListener('click', async () => {
            const textoReceita = document.getElementById('texto-receita').value;
            const tipoDoc = tituloDoDocumento();
            
            if(!textoReceita.trim()) return showToast('Digite o conteúdo do documento.', 'warning');
            if (!tipoDoc) return showToast('Informe o título do documento.', 'warning');

            const paciente = clinicaState.pacientes.find(p => String(p.id) === String(pacienteAtivoId));
            const profId = document.getElementById('pep-profissional').value;
            const profissional = clinicaState.profissionais.find(p => String(p.id) === String(profId));

            if (!profissional) return showToast('Selecione o Profissional Responsável.', 'error');

            document.getElementById('print-tipo-doc').textContent = tipoDoc;
            document.getElementById('print-nome-paciente').textContent = paciente.nome;
            document.getElementById('print-nasc-paciente').textContent = paciente.nascimento ? paciente.nascimento.split('-').reverse().join('/') : 'Não inf.';
            document.getElementById('print-cpf-paciente').textContent = paciente.cpf || 'Não inf.';
            document.getElementById('print-data').textContent = new Date().toLocaleDateString('pt-BR');
            document.getElementById('print-conteudo-receita').innerHTML = obterHTMLDocumento();
            document.getElementById('print-medico-nome').textContent = profissional.nome;
            document.getElementById('print-medico-registro').textContent = `${profissional.conselho}: ${profissional.registro}`;

            document.body.setAttribute('data-impressao', 'receita');
            window.print();

            if (tipoDoc === 'ENCAMINHAMENTO MÉDICO') {
                const especialidade = document.getElementById('encaminhamento-especialidade').value;
                await criarNotificacao({
                    tipo: 'encaminhamento',
                    titulo: `Encaminhamento: ${paciente.nome}`,
                    mensagem: `${profissional.nome} encaminhou ${paciente.nome} para ${especialidade || 'especialista'}. Ofereça o agendamento antes que o paciente saia da clínica.`,
                    pacienteId: paciente.id,
                    pacienteNome: paciente.nome
                });
                await registrarAuditoria({ acao: 'Criação', modulo: 'Prontuário', descricao: `Encaminhamento gerado para ${paciente.nome} (${especialidade || 'especialista'})` });
            }
        });
    }

    // ==========================================
    // BUSCA DE PACIENTES
    // ==========================================
    const inputBusca = document.getElementById('search-paciente');
    const btnBuscar = document.getElementById('btn-buscar-paciente');

    function executarBusca() {
        if (!inputBusca) return;
        const termo = inputBusca.value.toLowerCase().trim();
        const termoApenasNumeros = termo.replace(/\D/g, ''); 
        
        if (termo === '') return atualizarTabelaPacientes(clinicaState.pacientes);

        const pacientesFiltrados = clinicaState.pacientes.filter(p => {
            const nome = p.nome ? p.nome.toLowerCase() : '';
            const cpfApenasNumeros = (p.cpf ? p.cpf : '').replace(/\D/g, '');
            return nome.includes(termo) || (termoApenasNumeros !== '' && cpfApenasNumeros.includes(termoApenasNumeros));
        });

        atualizarTabelaPacientes(pacientesFiltrados);
    }

    if (btnBuscar) btnBuscar.addEventListener('click', executarBusca);
    if (inputBusca) inputBusca.addEventListener('keyup', executarBusca);
}

// ==========================================
// ANEXOS DO PACIENTE (BASE64 COM NOME CLICÁVEL)
// ==========================================
const ROTULOS_ANEXO = { foto: 'Foto do paciente', documento: 'Documento de identidade' };

function comprimirDocumentoBase64(file, maxDim = 1000, qualidade = 0.72) {
    return new Promise((resolve, reject) => {
        if (!file || !file.type.startsWith('image/')) {
            return reject(new Error('Envie o documento como imagem (Foto/Scanner JPG ou PNG).'));
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                if (width > maxDim || height > maxDim) {
                    if (width > height) {
                        height = Math.round((height * maxDim) / width);
                        width = maxDim;
                    } else {
                        width = Math.round((width * maxDim) / height);
                        height = maxDim;
                    }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                resolve({
                    nome: file.name || 'documento.jpg',
                    dataUrl: canvas.toDataURL('image/jpeg', qualidade)
                });
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function uploadAnexo(file, subpasta) {
    const maxDim = subpasta === 'foto' ? 320 : 1000;
    return await comprimirDocumentoBase64(file, maxDim, 0.75);
}

function obterUrlAnexo(item) {
    if (!item) return '';
    return typeof item === 'object' ? (item.dataUrl || '') : String(item);
}

function obterNomeAnexo(item, rotuloPadrao) {
    if (!item) return rotuloPadrao;
    return typeof item === 'object' && item.nome ? `${rotuloPadrao} (${item.nome})` : rotuloPadrao;
}

function abrirDocumentoEmNovaAba(urlOuBase64, titulo = 'Documento do Paciente') {
    if (!urlOuBase64) return;
    const novaJanela = window.open('', '_blank');
    if (!novaJanela) return showToast('Permita pop-ups para visualizar o documento.', 'warning');
    novaJanela.document.write(`
        <!DOCTYPE html>
        <html>
        <head><title>${escapeHTML(titulo)}</title></head>
        <body style="margin:0; background:#1B262C; display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; font-family:sans-serif;">
            <div style="padding:10px 20px; background:#0F4C75; color:#fff; width:100%; box-sizing:border-box; display:flex; justify-content:space-between; align-items:center;">
                <strong>${escapeHTML(titulo)}</strong>
                <a href="${urlOuBase64}" download="${escapeHTML(titulo)}.jpg" style="color:#fff; background:#17A673; padding:6px 14px; border-radius:6px; text-decoration:none; font-size:14px;">Baixar Arquivo</a>
            </div>
            <img src="${urlOuBase64}" style="max-width:95%; max-height:88vh; margin:auto; border-radius:6px; box-shadow:0 8px 25px rgba(0,0,0,0.5);">
        </body>
        </html>
    `);
    novaJanela.document.close();
}

function chipAnexo(rotulo, item, tipo, idx) {
    const dataIdx = idx !== undefined ? ` data-idx="${idx}"` : '';
    const nomeExibicao = obterNomeAnexo(item, rotulo);
    return `<span class="anexo-chip">
        <button type="button" class="btn-abrir-doc-base64" data-tipo="${tipo}"${dataIdx} style="background:none; border:none; color:var(--primary-color); font-weight:600; cursor:pointer; display:inline-flex; align-items:center; gap:6px;">
            <i class="fa-solid fa-file-lines"></i> ${escapeHTML(nomeExibicao)}
        </button>
        <button type="button" class="btn-remover-anexo" data-tipo="${tipo}"${dataIdx} title="Remover anexo"><i class="fa-solid fa-xmark"></i></button>
    </span>`;
}

function renderizarAnexosExistentes() {
    const wrapper = document.getElementById('anexos-existentes-container');
    const container = document.getElementById('anexos-existentes-lista');
    if (!wrapper || !container) return;

    const temAlgo = anexosEmEdicao && (
        anexosEmEdicao.foto ||
        anexosEmEdicao.documento ||
        (anexosEmEdicao.outros && anexosEmEdicao.outros.length > 0)
    );

    if (!temAlgo) {
        wrapper.style.display = 'none';
        container.innerHTML = '';
        return;
    }

    wrapper.style.display = 'block';
    let html = '';
    if (anexosEmEdicao.foto) html += chipAnexo(ROTULOS_ANEXO.foto, anexosEmEdicao.foto, 'foto');
    if (anexosEmEdicao.documento) html += chipAnexo(ROTULOS_ANEXO.documento, anexosEmEdicao.documento, 'documento');
    (anexosEmEdicao.outros || []).forEach((item, idx) => {
        html += chipAnexo(`Outro documento ${idx + 1}`, item, 'outro', idx);
    });
    container.innerHTML = html;
}

function dataLocalISO(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function concluirConsultaDeHoje(paciente, profissional) {
    try {
        const snap = await getDocs(query(
            collection(db, "agendamentos"),
            where("clinicaId", "==", clinicaState.sessao.clinicaId),
            where("data", "==", dataLocalISO())
        ));

        const ELEGIVEIS = ['agendado', 'confirmado', 'aguardando_atendimento'];
        const candidatos = snap.docs
            .map(d => ({ ...d.data(), id: String(d.id) }))
            .filter(a => String(a.pacId) === String(paciente.id)
                && String(a.profId) === String(profissional.id)
                && ELEGIVEIS.includes(a.status || 'agendado'))
            .sort((x, y) =>
                (x.status === 'aguardando_atendimento' ? 0 : 1) - (y.status === 'aguardando_atendimento' ? 0 : 1)
                || (x.hora || '').localeCompare(y.hora || ''));

        const ag = candidatos[0];
        if (!ag) return false;

        const valor = Number(ag.valorAtendimento || 0);
        const jaPaga = ag.statusPagamento === 'pago';
        const novos = {
            status: 'concluido',
            statusPagamento: valor > 0 ? (jaPaga ? 'pago' : 'pendente') : 'nao_aplica'
        };

        await updateDoc(doc(db, "agendamentos", ag.id), novos);

        const idx = clinicaState.agenda.agendamentos.findIndex(a => String(a.id) === ag.id);
        if (idx >= 0) clinicaState.agenda.agendamentos[idx] = { ...clinicaState.agenda.agendamentos[idx], ...novos };

        if (valor > 0 && !jaPaga) {
            await criarNotificacao({
                tipo: 'pagamento_pendente',
                titulo: 'Confirmar pagamento',
                mensagem: `A consulta de ${ag.pacNome} (${ag.procedimentoNome || ag.tipo || 'Consulta'}) foi concluída.`,
                pacienteId: ag.pacId,
                pacienteNome: ag.pacNome,
                agendamentoId: ag.id
            });
        }

        await registrarAuditoria({ acao: 'Edição', modulo: 'Agenda', descricao: `Consulta concluída pelo prontuário: ${ag.pacNome} (${ag.hora || '--:--'})` });
        atualizarAgenda();
        return true;
    } catch (error) {
        console.error("Erro ao concluir a consulta na agenda: ", error);
        showToast('A evolução foi salva, mas não foi possível concluir a consulta na agenda. Conclua pela Agenda.', 'warning');
        return false;
    }
}

export function abrirProntuario(idPaciente, opcoes = {}) {
    if (clinicaState.sessao.perfil !== 'Doutor(a)') {
        showToast('Acesso ao prontuário é restrito exclusivamente a médicos.', 'error');
        return;
    }

    const paciente = clinicaState.pacientes.find(p => String(p.id) === String(idPaciente));
    
    if (paciente) {
        document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));
        document.querySelectorAll('.menu-btn').forEach(btn => btn.classList.remove('active'));
        document.getElementById('pacientes').classList.add('active');
        document.querySelector('[data-target="pacientes"]').classList.add('active');
        
        pacienteAtivoId = paciente.id;
        sairModoEdicaoEvolucao();
        
        const selProf = document.getElementById('pep-profissional');
        if (selProf) {
            let profsPermitidos = clinicaState.profissionais;
            let travaSelect = false;

            if (clinicaState.sessao.perfil === 'Doutor(a)') {
                profsPermitidos = clinicaState.profissionais.filter(p => p.nome.trim().toLowerCase() === clinicaState.sessao.nome.trim().toLowerCase());
                travaSelect = true;
            }

            selProf.innerHTML = '<option value="" disabled selected>Selecione para assinar...</option>' + 
                profsPermitidos.map(p => `<option value="${p.id}">${escapeHTML(p.nome)} (${escapeHTML(p.conselho)}: ${escapeHTML(p.registro)})</option>`).join('');
            
            if (travaSelect && profsPermitidos.length > 0) {
                selProf.value = profsPermitidos[0].id;
                selProf.style.pointerEvents = 'none'; 
                selProf.style.backgroundColor = '#e2e8f0'; 
            } else {
                selProf.style.pointerEvents = 'auto';
                selProf.style.backgroundColor = '';
            }
        }
        
        renderizarEvolucoes(paciente);
        renderizarResumoRapidoProntuario(paciente);
        renderizarExamesSolicitados(paciente);
        renderizarResumoPacienteAtivo();
        aoAbrirProntuario(paciente, opcoes.aba);
        aoAbrirProntuarioAtendimento(paciente);

        const grupoEspecialidade = document.getElementById('grupo-especialidade-encaminhamento');
        if (grupoEspecialidade) grupoEspecialidade.style.display = 'none';
        const textoReceita = document.getElementById('texto-receita');
        if (textoReceita) textoReceita.value = '';
        resetarSeletorModelo(paciente);
        
        const areaHistorico = document.querySelector('.pep-historico'); 
        const formEvolucao = document.querySelector('.pep-nova-evolucao'); 
        const tabBtnExames = document.getElementById('tab-btn-exames');
        
        if (clinicaState.sessao.perfil !== 'Doutor(a)') {
            if(areaHistorico) areaHistorico.style.display = 'none';
            if(formEvolucao) formEvolucao.style.display = 'none';
            if(tabBtnExames) tabBtnExames.style.display = 'none';
        } else {
            if(areaHistorico) areaHistorico.style.display = 'block';
            if(formEvolucao) formEvolucao.style.display = 'block';
            if(tabBtnExames) tabBtnExames.style.display = '';
        }

        const listaContainer = document.getElementById('lista-pacientes-container');
        if (listaContainer) listaContainer.style.display = 'none';
        document.getElementById('prontuario-ativo').style.display = 'block';
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

function extrairCampoEvolucao(texto, rotulos) {
    const alternativas = rotulos.join('|');
    const re = new RegExp('\\*\\*(?:' + alternativas + ')[^*]*:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\s*\\*\\*|$)', 'i');
    const m = texto.match(re);
    const valor = m ? m[1].trim() : '';
    return valor && valor !== 'N/A' ? valor : '';
}

function resumirTexto(texto, limite) {
    return texto.length > limite ? texto.slice(0, limite).trimEnd() + '…' : texto;
}

function renderizarResumoRapidoProntuario(paciente) {
    const el = document.getElementById('pep-resumo-rapido');
    if (!el) return;

    const evolucoes = paciente.evolucoes || [];
    const ultima = evolucoes[evolucoes.length - 1];

    if (!ultima) {
        el.innerHTML = `<div class="resumo-rapido-titulo"><i class="fa-solid fa-circle-info"></i> Primeira consulta</div>
            <p class="resumo-rapido-vazio">Este paciente ainda não tem evoluções registradas.</p>`;
        return;
    }

    const texto = decriptar(ultima.texto);
    const diagnostico = extrairCampoEvolucao(texto, ['Hipótese Diagnóstica', 'Suspeita Diagnóstica', 'Suposto Diagnóstico', 'Diagnóstico']);
    const conduta = extrairCampoEvolucao(texto, ['Conduta']);

    el.innerHTML = `
        <div class="resumo-rapido-titulo"><i class="fa-solid fa-clock-rotate-left"></i> Resumo da última consulta</div>
        <div class="resumo-rapido-grid">
            <div><span class="rotulo">Data</span><strong>${escapeHTML(ultima.data || '-')}</strong></div>
            <div><span class="rotulo">Hipótese diagnóstica</span><strong>${escapeHTML(diagnostico || 'Não informada')}</strong></div>
            <div><span class="rotulo">Conduta registrada</span><strong>${escapeHTML(conduta ? resumirTexto(conduta, 140) : 'Não informada')}</strong></div>
            <div><span class="rotulo">Atendimentos registrados</span><strong>${evolucoes.length}</strong></div>
        </div>`;
}

function renderizarEvolucoes(paciente) {
    const container = document.getElementById('pep-timeline');
    const containerLateral = document.getElementById('pep-timeline-lateral');
    const lista = paciente.evolucoes || [];

    const html = lista.map((evo, idxOriginal) => ({ evo, idxOriginal })).reverse().map(({ evo, idxOriginal }) => {
        const textoDescriptografado = decriptar(evo.texto);

        const textoFormatado = escapeHTML(textoDescriptografado)
            .replace(/\n/g, '<br>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

        const podeMexerHoje = clinicaState.sessao.perfil === 'Doutor(a)' && evolucaoEditavelHoje(evo);
        const botoesHoje = podeMexerHoje ? `
            <span class="evo-acoes-dia">
                <button type="button" class="btn-evo-mini btn-editar-evo-hoje" data-idx="${idxOriginal}" title="Editar até 23:59 de hoje">
                    <i class="fa-solid fa-pen"></i> Editar
                </button>
                <button type="button" class="btn-evo-mini danger btn-excluir-evo-hoje" data-idx="${idxOriginal}" title="Remover evolução lançada no paciente errado">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </span>` : `<span class="assinatura-meta" title="Prontuário fechado após meia-noite"><i class="fa-solid fa-shield-halved"></i> Fechado</span>`;

        return `
        <details class="timeline-item" open>
            <summary class="timeline-meta">
                <span><i class="fa-regular fa-calendar"></i> <strong>${escapeHTML(evo.data)}</strong> ${evo.editadoEm ? `<small>(retificado às ${escapeHTML(evo.editadoEm)})</small>` : ''}</span>
                <span class="assinatura-meta"><i class="fa-solid fa-lock"></i> ${escapeHTML(evo.assinatura)}</span>
                ${evo.duracaoSegundos ? `<span class="assinatura-meta"><i class="fa-regular fa-clock"></i> Duração: ${formatarDuracaoCurta(evo.duracaoSegundos)}</span>` : ''}
                ${botoesHoje}
            </summary>
            <div class="timeline-content">${textoFormatado}</div>
        </details>
    `}).join('') || '<p style="color:var(--text-light); padding:12px;">Sem registros anteriores.</p>';

    if (container) container.innerHTML = html;
    if (containerLateral) containerLateral.innerHTML = html;
}

function renderizarExamesSolicitados(paciente) {
    const container = document.getElementById('pep-exames-timeline');
    if (!container) return;

    const lista = paciente.examesSolicitados || [];

    container.innerHTML = lista.slice().reverse().map(s => {
        const examesTexto = decriptar(s.examesCripto);
        return `
        <div class="dash-list-item" style="align-items: flex-start;">
            <div>
                <strong><i class="fa-solid fa-flask-vial"></i> ${escapeHTML(examesTexto)}</strong><br>
                <span style="color: var(--text-light); font-size: 0.85rem;">Solicitado por ${escapeHTML(s.profissional)} em ${escapeHTML(s.data)}</span>
            </div>
        </div>`;
    }).join('') || '<p style="color: var(--text-light); text-align: center; padding: 20px;">Nenhum exame solicitado ainda.</p>';
}

export function renderizarResumoPacienteAtivo() {
    if (!pacienteAtivoId) return;
    const paciente = clinicaState.pacientes.find(p => String(p.id) === String(pacienteAtivoId));
    if (!paciente) return;
    
    const elNome = document.getElementById('pep-nome-paciente');
    const elDados = document.getElementById('pep-dados-basicos');
    const elConvenio = document.getElementById('pep-convenio');
    const elAlergias = document.getElementById('pep-alergias');

    if (elNome) elNome.textContent = paciente.nome;
    const idade = calcularIdade(paciente.nascimento);
    const dataNasc = paciente.nascimento ? paciente.nascimento.split('-').reverse().join('/') + (idade ? ` (${idade})` : '') : 'Não inf.';
    if (elDados) elDados.textContent = `CPF: ${paciente.cpf} | Nasc: ${dataNasc} | Tel: ${paciente.telefone || 'Não inf.'}`;
    
    if (elConvenio) elConvenio.innerHTML = `<i class="fa-solid fa-address-card"></i> ${escapeHTML(paciente.convenio || 'Particular')}`;
    
    if (elAlergias) {
        if (paciente.alergias) {
            elAlergias.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Alergias: ${escapeHTML(paciente.alergias)}`;
            elAlergias.className = 'pep-badge danger';
        } else {
            elAlergias.innerHTML = `<i class="fa-solid fa-check"></i> Sem alergias`;
            elAlergias.className = 'pep-badge neutral';
        }
    }

    const elAvatar = document.getElementById('pep-avatar');
    const urlFoto = obterUrlAnexo(paciente.anexos?.foto);
    if (elAvatar) {
        elAvatar.innerHTML = urlFoto
            ? `<img src="${urlFoto}" alt="Foto de ${escapeHTML(paciente.nome)}">`
            : '<i class="fa-solid fa-hospital-user"></i>';
    }

    const elAnexosLinks = document.getElementById('pep-anexos-links');
    if (elAnexosLinks) {
        const anexos = paciente.anexos || {};
        let html = '';
        if (anexos.documento) {
            html += `<button type="button" class="pep-badge link btn-abrir-anexo-pep" data-tipo="documento" style="border:none;"><i class="fa-solid fa-id-card"></i> Documento</button>`;
        }
        if (anexos.outros && anexos.outros.length > 0) {
            anexos.outros.forEach((item, idx) => {
                const rotulo = obterNomeAnexo(item, `Anexo ${idx + 1}`);
                html += `<button type="button" class="pep-badge link btn-abrir-anexo-pep" data-tipo="outro" data-idx="${idx}" style="border:none;"><i class="fa-solid fa-paperclip"></i> ${escapeHTML(rotulo)}</button>`;
            });
        }
        elAnexosLinks.innerHTML = html;
    }
}

// ==========================================
// CADASTRO ATIVO DO PACIENTE
// ==========================================
const MESES_PARA_INATIVIDADE = 6;

function obterStatusAtividade(pacienteId) {
    const consultas = clinicaState.agenda.agendamentos.filter(a => String(a.pacId) === String(pacienteId) && a.status !== 'cancelado');

    if (consultas.length === 0) {
        return { texto: 'Novo', classe: 'info' };
    }

    const ultimaData = consultas.reduce((maisRecente, a) => a.data > maisRecente ? a.data : maisRecente, consultas[0].data);

    const limite = new Date();
    limite.setMonth(limite.getMonth() - MESES_PARA_INATIVIDADE);
    const limiteIso = limite.toISOString().split('T')[0];

    return ultimaData >= limiteIso
        ? { texto: 'Ativo', classe: 'success' }
        : { texto: 'Inativo', classe: 'warning' };
}

export function atualizarTabelaPacientes(lista = clinicaState.pacientes) {
    const patientListBody = document.getElementById('patient-table-body-list');
    if (patientListBody) {
        patientListBody.innerHTML = lista.map(p => {
            const status = obterStatusAtividade(p.id);
            return `<tr>
                <td><strong>${escapeHTML(p.nome)}</strong></td>
                <td>${escapeHTML(p.cpf)}</td>
                <td>${escapeHTML(p.convenio)}</td>
                <td style="color:red">${p.alergias ? escapeHTML(p.alergias) : '-'}</td>
                <td><span class="badge ${status.classe}" title="Baseado na última consulta agendada">${status.texto}</span></td>
                <td>
                    <div class="row-actions">
                        ${clinicaState.sessao.perfil === 'Doutor(a)' ? `
                            <button class="btn-action btn-abrir-prontuario" data-id="${p.id}" title="Acessar Ficha">
                                <i class="fa-regular fa-folder-open"></i>
                            </button>
                        ` : `
                            <button class="btn-action btn-edit btn-editar-paciente" data-id="${p.id}" title="Editar Dados">
                                <i class="fa-solid fa-pen"></i>
                            </button>
                            <button class="btn-action btn-delete btn-excluir-paciente" data-id="${p.id}" title="Excluir Cadastro">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        `}
                    </div>
                </td>
            </tr>`;
        }).join('');
    }
    renderizarResumoPacienteAtivo();
}

// ==========================================
// LEITURA DE DADOS COM DESCRIPTOGRAFIA
// ==========================================
export async function carregarPacientes() {
    try {
        const q = query(
            collection(db, "pacientes"),
            where("clinicaId", "==", clinicaState.sessao.clinicaId)
        );
        const querySnapshot = await getDocs(q);

        clinicaState.pacientes = [];
        querySnapshot.forEach((doc) => {
            const d = doc.data();
            clinicaState.pacientes.push({
                ...d,
                id: String(doc.id),
                nome: decriptar(d.nome),
                cpf: decriptar(d.cpf),
                rg: decriptar(d.rg),
                nascimento: decriptar(d.nascimento),
                mae: decriptar(d.mae),
                telefone: decriptar(d.telefone),
                email: decriptar(d.email),
                sangue: decriptar(d.sangue),
                alergias: decriptar(d.alergias),
                convenio: decriptar(d.convenio),
                carteirinha: decriptar(d.carteirinha),
                emergencia: decriptar(d.emergencia),
                responsavel: decriptar(d.responsavel)
            });
        });

        atualizarTabelaPacientes();
    } catch (error) {
        showToast('Erro ao carregar lista de pacientes.', 'error');
    }
}

export async function carregarProfissionais() {
    try {
        const q = query(
            collection(db, "profissionais"), 
            where("clinicaId", "==", clinicaState.sessao.clinicaId)
        );
        const querySnapshot = await getDocs(q);
        
        clinicaState.profissionais = [];
        querySnapshot.forEach((doc) => {
            const d = doc.data();
            clinicaState.profissionais.push({
                ...d,
                id: String(doc.id),
                nome: decriptar(d.nome),
                cpf: decriptar(d.cpf),
                rg: decriptar(d.rg),
                nascimento: decriptar(d.nascimento),
                mae: decriptar(d.mae),
                telefone: decriptar(d.telefone),
                email: decriptar(d.email),
                conselho: decriptar(d.conselho),
                registro: decriptar(d.registro),
                especialidade: decriptar(d.especialidade),
                rqe: decriptar(d.rqe),
                vinculo: decriptar(d.vinculo)
            });
        });
        
        atualizarTabelaProfissionais();
    } catch (error) {
        showToast('Erro ao carregar lista de profissionais.', 'error');
    }
}

export function atualizarTabelaProfissionais() {
    const profListBody = document.getElementById('prof-table-body-list');
    if (profListBody) {
        profListBody.innerHTML = clinicaState.profissionais.map(p => 
            `<tr>
                <td><strong>${escapeHTML(p.nome)}</strong></td>
                <td>${escapeHTML(p.especialidade)}</td>
                <td>${escapeHTML(p.conselho)} ${escapeHTML(p.registro)}</td>
                <td>
                    <button class="btn-action btn-delete btn-excluir-prof" data-id="${p.id}">
                        <i class="fa-solid fa-trash"></i> Excluir
                    </button>
                </td>
            </tr>`
        ).join('');
    }
}