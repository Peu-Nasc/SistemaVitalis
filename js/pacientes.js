import { clinicaState } from './state.js';
import { showToast, escapeHTML, encriptar, decriptar, comEstadoDeCarregamento, confirmarAcao } from './Ferramentas.js';
import { atualizarAgenda } from './agenda.js';
import { criarNotificacao } from './notificacoes.js';

import { db, storage } from './firebase.js';
import { collection, addDoc, getDocs, doc, updateDoc, deleteDoc, query, where } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js';
import { registrarAuditoria } from './auditoria.js';

let pacienteAtivoId = null;
let pacienteEmEdicaoId = null; 
// Cópia de trabalho dos anexos do paciente em edição - {foto, documento, outros: []}.
// null quando não há paciente em edição (cadastro novo).
let anexosEmEdicao = null;
// URLs de anexos removidos pelo usuário nesta sessão de edição, apagadas do
// Storage só depois que o cadastro é salvo com sucesso.
let anexosParaExcluirDoStorage = [];

export function initPacientes() {
    const modalCadastro = document.getElementById('modal-cadastro');
    const tipoCadastro = document.getElementById('tipo-cadastro');

    // Limpa o atributo que diz qual área de impressão mostrar (Receituário
    // A4 ou Prontuário A5, ver btn-imprimir-receita/btn-imprimir-pep) assim
    // que a caixa de diálogo de impressão do navegador fecha.
    window.addEventListener('afterprint', () => document.body.removeAttribute('data-impressao'));

    document.getElementById('btn-novo-paciente').addEventListener('click', () => {
        // Trava real (não só visual): o botão já fica oculto pro Doutor(a)
        // em login.js, mas essa segunda barreira evita depender só do
        // CSS/display caso alguém force o clique via DevTools.
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

        // Reseta o estado de anexos - o handler de edição (btnEditar) sobrescreve
        // isso logo em seguida quando o cadastro é de um paciente existente.
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
        modalCadastro.classList.add('active');
    }

    tipoCadastro.addEventListener('change', (e) => abrirModalCadastro(e.target.value));

    // Clique para remover um anexo já existente (durante edição de paciente) -
    // só é removido do Storage de fato depois que o formulário é salvo.
    const listaAnexosExistentes = document.getElementById('anexos-existentes-lista');
    if (listaAnexosExistentes) {
        listaAnexosExistentes.addEventListener('click', (e) => {
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
                const idx = parseInt(btn.getAttribute('data-idx'));
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
    // SALVAMENTO DE CADASTRO COM CRIPTOGRAFIA
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
                    // Envia os arquivos novos ANTES de gravar o cadastro - se algum
                    // upload falhar, interrompemos aqui e nada é salvo pela metade.
                    const inputFoto = document.getElementById('cad-anexo-foto');
                    const inputDocumento = document.getElementById('cad-anexo-documento');
                    const inputOutros = document.getElementById('cad-anexo-outros');

                    let novaFotoUrl = null;
                    let novoDocumentoUrl = null;
                    const novosOutrosUrls = [];

                    try {
                        if (inputFoto.files[0]) novaFotoUrl = await uploadAnexo(inputFoto.files[0], 'foto');
                        if (inputDocumento.files[0]) novoDocumentoUrl = await uploadAnexo(inputDocumento.files[0], 'documento');
                        for (const arquivo of inputOutros.files) {
                            novosOutrosUrls.push(await uploadAnexo(arquivo, 'outros'));
                        }
                    } catch (uploadError) {
                        console.error("Erro ao enviar anexo: ", uploadError);
                        showToast('Falha ao enviar um dos anexos. O cadastro não foi salvo.', 'error');
                        return;
                    }

                    // Anexos são opcionais (conforme definido em reunião) - só
                    // gravamos o campo se houver algo, novo ou já existente.
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

                    // Só remove do Storage depois que o cadastro foi salvo com
                    // sucesso - se der erro antes disso, os arquivos "removidos"
                    // continuam intactos e o usuário pode tentar salvar de novo.
                    for (const urlAntiga of anexosParaExcluirDoStorage) {
                        try {
                            await deleteObject(ref(storage, urlAntiga));
                        } catch (removeError) {
                            console.error("Erro ao remover anexo antigo do Storage: ", removeError);
                        }
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
        pacienteAtivoId = null;
        renderizarResumoPacienteAtivo();
    });

    // ==========================================
    // IMPRESSÃO DO PRONTUÁRIO (RESUMO EM A5)
    // Formato compacto pra grampear na pasta física do paciente - mostra os
    // dados básicos e a evolução mais recente, não o histórico inteiro
    // (esse fica na tela, aba "Histórico Clínico"). Usa folha A5, diferente
    // do Receituário (btn-imprimir-receita), que é A4 - ver @media print
    // em style.css, que escolhe o tamanho pelo atributo data-impressao.
    // ==========================================
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

            // Sinaliza pro CSS de impressão que é o Prontuário (A5) que deve
            // aparecer - ver comentário equivalente no handler do Receituário.
            document.body.setAttribute('data-impressao', 'pep');
            window.print();
        });
    }

    // ==========================================
    // SALVAMENTO DE EVOLUÇÃO COM CRIPTOGRAFIA
    // ==========================================
    document.getElementById('form-evolucao').addEventListener('submit', async (e) => {
        e.preventDefault();
        if(!pacienteAtivoId) return;
        
        const paciente = clinicaState.pacientes.find(p => String(p.id) === String(pacienteAtivoId));
        const btnSalvar = e.target.querySelector('button[type="submit"]');

        await comEstadoDeCarregamento(btnSalvar, 'Assinando...', async () => {
            const textoProntuario = `**Anamnese:** ${document.getElementById('pep-anamnese').value}
    **Exame Físico:** ${document.getElementById('pep-exame-fisico').value}
    **Suspeita Diagnóstica:** ${document.getElementById('pep-diagnostico').value || 'N/A'}
    **Conduta e Prescrição:** ${document.getElementById('pep-prescricao').value}`.trim(); 

            const textoCriptografado = encriptar(textoProntuario);

            const profId = document.getElementById('pep-profissional').value;
            const profissional = clinicaState.profissionais.find(p => String(p.id) === String(profId));
            
            if (!profissional) {
                showToast('Selecione um profissional para assinar a ficha.', 'warning');
                return;
            }

            const novaEvolucao = {
                data: new Date().toLocaleString('pt-BR'),
                texto: textoCriptografado,
                assinatura: `Assinado digitalmente por ${profissional.nome} | ${profissional.conselho}: ${profissional.registro}`
            };

            if (!paciente.evolucoes) paciente.evolucoes = [];
            paciente.evolucoes.push(novaEvolucao);

            // Se o médico informou "retornar em X dias", calcula a data e
            // grava no paciente (fora do texto criptografado, pra poder
            // usar direto num painel de "Revisões Pendentes" no Dashboard)
            const diasRetornoInput = document.getElementById('pep-retorno-dias').value;
            const dadosAtualizados = { evolucoes: paciente.evolucoes };

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

                // Se um retorno foi marcado, avisa a recepção AGORA MESMO -
                // não espera o paciente entrar na lista de "atrasados" lá na
                // frente, a pendência de agendar já nasce na hora certa.
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
                e.target.reset(); 
                
                if (clinicaState.sessao.perfil === 'Doutor(a)') {
                    document.getElementById('pep-profissional').value = profId;
                }
                showToast('Evolução salva no Prontuário com sucesso!');
                await registrarAuditoria({ acao: 'Criação', modulo: 'Prontuário', descricao: `Evolução registrada para ${paciente.nome} por ${profissional.nome}` });
            } catch (error) {
                console.error("Erro ao salvar evolução: ", error);
                showToast('Erro de conexão ao salvar ficha.', 'error');
                paciente.evolucoes.pop(); 
            }
        });
    });

    // ==========================================
    // EXAMES SOLICITADOS
    // Aba independente da evolução: registra a solicitação no prontuário
    // (criptografada, como o restante do histórico clínico) e dispara uma
    // notificação em tempo real para a recepção conseguir oferecer o
    // agendamento ainda com o paciente na clínica.
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
                showToast('Selecione o profissional responsável na aba "Nova Evolução" antes de solicitar exames.', 'warning');
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

                    // Notificação em texto simples (não criptografada) - mesmo
                    // padrão já usado no aviso de retorno pendente: é um recado
                    // operacional de curta duração pra recepção agir, não um
                    // dado de prontuário de longo prazo.
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
    // EXAMES / IMAGENS ANEXADAS AO PRONTUÁRIO
    // Diferente da aba "Exames Solicitados" (que só registra o PEDIDO do
    // exame): aqui entra o RESULTADO já realizado - laudo em PDF, foto de
    // raio-X, exame de imagem etc. O arquivo em si vai pro Storage (mesmo
    // padrão dos anexos de cadastro, sem criptografia); só a descrição
    // (dado clínico em texto livre) é criptografada como o restante do
    // histórico.
    // ==========================================
    const formImagensExame = document.getElementById('form-imagens-exame');
    if (formImagensExame) {
        formImagensExame.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!pacienteAtivoId) return;

            const paciente = clinicaState.pacientes.find(p => String(p.id) === String(pacienteAtivoId));
            const inputArquivo = document.getElementById('pep-imagem-arquivo');
            const inputDescricao = document.getElementById('pep-imagem-descricao');
            const btnSalvar = e.target.querySelector('button[type="submit"]');

            if (!inputArquivo.files || inputArquivo.files.length === 0) {
                showToast('Selecione ao menos um arquivo.', 'warning');
                return;
            }

            const profId = document.getElementById('pep-profissional').value;
            const profissional = clinicaState.profissionais.find(p => String(p.id) === String(profId));
            if (!profissional) {
                showToast('Selecione o profissional responsável na aba "Nova Evolução" antes de anexar exames.', 'warning');
                return;
            }

            await comEstadoDeCarregamento(btnSalvar, 'Enviando...', async () => {
                const descricao = inputDescricao.value.trim();
                const novosItens = [];

                // Envia todos os arquivos ANTES de gravar no Firestore - se algum
                // upload falhar, nada é salvo pela metade (mesmo padrão do
                // cadastro de paciente).
                try {
                    for (const arquivo of inputArquivo.files) {
                        const url = await uploadAnexo(arquivo, `prontuario/${paciente.id}`);
                        novosItens.push({
                            url,
                            nomeArquivo: arquivo.name,
                            tipo: arquivo.type || '',
                            descricaoCripto: encriptar(descricao),
                            data: new Date().toLocaleString('pt-BR'),
                            profissional: profissional.nome
                        });
                    }
                } catch (uploadError) {
                    console.error("Erro ao enviar exame/imagem: ", uploadError);
                    showToast('Falha ao enviar o(s) arquivo(s). Nada foi salvo no prontuário.', 'error');
                    return;
                }

                if (!paciente.imagensExames) paciente.imagensExames = [];
                paciente.imagensExames.push(...novosItens);

                try {
                    await updateDoc(doc(db, "pacientes", paciente.id), { imagensExames: paciente.imagensExames });

                    renderizarImagensExames(paciente);
                    e.target.reset();
                    showToast('Exame(s)/imagem(ns) anexado(s) ao prontuário com sucesso!', 'success');
                    await registrarAuditoria({ acao: 'Criação', modulo: 'Prontuário', descricao: `Exame/imagem anexado para ${paciente.nome} (${novosItens.length} arquivo(s))` });
                } catch (error) {
                    console.error("Erro ao salvar exame/imagem no prontuário: ", error);
                    showToast('Erro de conexão ao salvar no prontuário.', 'error');
                    paciente.imagensExames.splice(paciente.imagensExames.length - novosItens.length, novosItens.length);
                }
            });
        });
    }

    // Exclusão de um exame/imagem já anexado - delegação de clique no grid
    const gridImagensExames = document.getElementById('pep-imagens-grid');
    if (gridImagensExames) {
        gridImagensExames.addEventListener('click', async (e) => {
            const btnExcluir = e.target.closest('.btn-excluir-imagem-exame');
            if (!btnExcluir || !pacienteAtivoId) return;

            const idx = parseInt(btnExcluir.getAttribute('data-idx'));
            const paciente = clinicaState.pacientes.find(p => String(p.id) === String(pacienteAtivoId));
            if (!paciente || !paciente.imagensExames || !paciente.imagensExames[idx]) return;

            if (await confirmarAcao('Deseja realmente excluir este exame/imagem do prontuário?', { titulo: 'Excluir anexo', textoConfirmar: 'Excluir' })) {
                const item = paciente.imagensExames[idx];
                const copiaAnterior = [...paciente.imagensExames];
                paciente.imagensExames.splice(idx, 1);

                try {
                    await updateDoc(doc(db, "pacientes", paciente.id), { imagensExames: paciente.imagensExames });

                    try {
                        await deleteObject(ref(storage, item.url));
                    } catch (removeError) {
                        console.error("Erro ao remover arquivo do Storage: ", removeError);
                    }

                    renderizarImagensExames(paciente);
                    showToast('Anexo removido do prontuário.', 'success');
                    await registrarAuditoria({ acao: 'Exclusão', modulo: 'Prontuário', descricao: `Exame/imagem removido de ${paciente.nome}: ${item.nomeArquivo}` });
                } catch (error) {
                    console.error("Erro ao excluir exame/imagem: ", error);
                    showToast('Erro de conexão ao excluir.', 'error');
                    paciente.imagensExames = copiaAnterior;
                }
            }
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

                    // Carrega os anexos já enviados (abrirModalCadastro zerou o
                    // estado acima - aqui sobrescrevemos com os dados reais)
                    anexosEmEdicao = paciente.anexos
                        ? { foto: paciente.anexos.foto || null, documento: paciente.anexos.documento || null, outros: [...(paciente.anexos.outros || [])] }
                        : { foto: null, documento: null, outros: [] };
                    anexosParaExcluirDoStorage = [];
                    renderizarAnexosExistentes();
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
    // ENCAMINHAMENTO: mostra o seletor de especialidade só quando o
    // documento escolhido é "Encaminhamento Especializado", e gera um
    // texto padrão pronto para revisão do médico antes de imprimir.
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
            const tipoDoc = document.getElementById('tipo-documento-impressao').value;
            
            if(!textoReceita.trim()) return showToast('Digite o conteúdo do documento.', 'warning');

            const paciente = clinicaState.pacientes.find(p => String(p.id) === String(pacienteAtivoId));
            const profId = document.getElementById('pep-profissional').value;
            const profissional = clinicaState.profissionais.find(p => String(p.id) === String(profId));

            if (!profissional) return showToast('Selecione o Profissional Responsável.', 'error');

            document.getElementById('print-tipo-doc').textContent = tipoDoc;
            document.getElementById('print-nome-paciente').textContent = paciente.nome;
            document.getElementById('print-nasc-paciente').textContent = paciente.nascimento ? paciente.nascimento.split('-').reverse().join('/') : 'Não inf.';
            document.getElementById('print-cpf-paciente').textContent = paciente.cpf || 'Não inf.';
            document.getElementById('print-data').textContent = new Date().toLocaleDateString('pt-BR');
            document.getElementById('print-conteudo-receita').textContent = textoReceita;
            document.getElementById('print-medico-nome').textContent = profissional.nome;
            document.getElementById('print-medico-registro').textContent = `${profissional.conselho}: ${profissional.registro}`;

            // Sinaliza pro CSS de impressão (@media print) que é o Receituário
            // que deve aparecer - ele usa folha A4, diferente do Prontuário
            // (A5, ver btn-imprimir-pep) que compartilha a mesma tela.
            document.body.setAttribute('data-impressao', 'receita');
            window.print();

            // ENCAMINHAMENTO ESPECIALIZADO: avisa a recepção pra ela já
            // oferecer o agendamento com o especialista antes do paciente
            // sair da clínica - mesmo padrão usado pra exames solicitados.
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
// ANEXOS DO PACIENTE (foto, documento de identidade, outros)
// Armazenados no Firebase Storage; a URL de download fica salva no
// próprio documento do paciente (não são dados sensíveis, então não
// passam por encriptar()/decriptar() como os demais campos).
// ==========================================
const ROTULOS_ANEXO = { foto: 'Foto do paciente', documento: 'Documento de identidade' };

function chipAnexo(rotulo, url, tipo, idx) {
    const dataIdx = idx !== undefined ? ` data-idx="${idx}"` : '';
    return `<span class="anexo-chip">
        <a href="${url}" target="_blank" rel="noopener"><i class="fa-solid fa-paperclip"></i> ${escapeHTML(rotulo)}</a>
        <button type="button" class="btn-remover-anexo" data-tipo="${tipo}"${dataIdx} title="Remover anexo"><i class="fa-solid fa-xmark"></i></button>
    </span>`;
}

function renderizarAnexosExistentes() {
    const wrapper = document.getElementById('anexos-existentes-container');
    const container = document.getElementById('anexos-existentes-lista');
    if (!wrapper || !container) return;

    const temAlgo = anexosEmEdicao && (anexosEmEdicao.foto || anexosEmEdicao.documento || (anexosEmEdicao.outros && anexosEmEdicao.outros.length > 0));

    if (!temAlgo) {
        wrapper.style.display = 'none';
        container.innerHTML = '';
        return;
    }

    wrapper.style.display = 'block';
    let html = '';
    if (anexosEmEdicao.foto) html += chipAnexo(ROTULOS_ANEXO.foto, anexosEmEdicao.foto, 'foto');
    if (anexosEmEdicao.documento) html += chipAnexo(ROTULOS_ANEXO.documento, anexosEmEdicao.documento, 'documento');
    (anexosEmEdicao.outros || []).forEach((url, idx) => {
        html += chipAnexo(`Outro documento ${idx + 1}`, url, 'outro', idx);
    });
    container.innerHTML = html;
}

// Envia um arquivo para o Storage em pacientes/{clinicaId}/{subpasta}/... e
// devolve a URL pública de download já salva no cadastro do paciente.
async function uploadAnexo(file, subpasta) {
    const nomeSeguro = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const caminho = `pacientes/${clinicaState.sessao.clinicaId}/${subpasta}/${Date.now()}_${nomeSeguro}`;
    const arquivoRef = ref(storage, caminho);
    await uploadBytes(arquivoRef, file);
    return await getDownloadURL(arquivoRef);
}

export function abrirProntuario(idPaciente) {
    // Trava real (não só visual): apenas médicos acessam prontuário de jeito
    // nenhum, mesmo que o botão apareça por algum outro caminho.
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
        renderizarExamesSolicitados(paciente);
        renderizarImagensExames(paciente);
        renderizarResumoPacienteAtivo();

        // Reseta o gerador de documentos ao trocar de paciente, para não
        // arrastar um texto de encaminhamento gerado para outra pessoa
        const grupoEspecialidade = document.getElementById('grupo-especialidade-encaminhamento');
        if (grupoEspecialidade) grupoEspecialidade.style.display = 'none';
        const textoReceita = document.getElementById('texto-receita');
        if (textoReceita) textoReceita.value = '';

        // Reseta o formulário de anexo de exame/imagem ao trocar de paciente,
        // pra não arrastar arquivo/descrição selecionados para outra pessoa
        const formImagensExameReset = document.getElementById('form-imagens-exame');
        if (formImagensExameReset) formImagensExameReset.reset();
        
        const areaHistorico = document.querySelector('.pep-historico'); 
        const formEvolucao = document.querySelector('.pep-nova-evolucao'); 
        // Aba de Exames Solicitados é clínica (mesmo nível de sigilo da
        // evolução) - só aparece pra quem está logado como Doutor(a).
        // Escondida por id, não pela classe .pep-nova-evolucao/.pep-historico,
        // porque essas classes já se repetem em outros blocos da tela e
        // querySelector só pegaria o primeiro elemento.
        const tabBtnExames = document.getElementById('tab-btn-exames');
        const tabBtnImagens = document.getElementById('tab-btn-imagens');
        
        if (clinicaState.sessao.perfil !== 'Doutor(a)') {
            if(areaHistorico) areaHistorico.style.display = 'none';
            if(formEvolucao) formEvolucao.style.display = 'none';
            if(tabBtnExames) tabBtnExames.style.display = 'none';
            if(tabBtnImagens) tabBtnImagens.style.display = 'none';
        } else {
            if(areaHistorico) areaHistorico.style.display = 'block';
            if(formEvolucao) formEvolucao.style.display = 'block';
            if(tabBtnExames) tabBtnExames.style.display = '';
            if(tabBtnImagens) tabBtnImagens.style.display = '';
        }

        const listaContainer = document.getElementById('lista-pacientes-container');
        if (listaContainer) listaContainer.style.display = 'none';
        document.getElementById('prontuario-ativo').style.display = 'block';
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

function renderizarEvolucoes(paciente) {
    const container = document.getElementById('pep-timeline');
    
    container.innerHTML = paciente.evolucoes.slice().reverse().map(evo => {
        const textoDescriptografado = decriptar(evo.texto);

        let textoFormatado = escapeHTML(textoDescriptografado)
            .replace(/\n/g, '<br>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
            
        return `
        <details class="timeline-item">
            <summary class="timeline-meta">
                <span><i class="fa-regular fa-calendar"></i> <strong>${evo.data}</strong></span>
                <span class="assinatura-meta"><i class="fa-solid fa-lock"></i> ${escapeHTML(evo.assinatura)}</span>
            </summary>
            <div class="timeline-content">${textoFormatado}</div>
        </details>
    `}).join('') || '<p>Sem registros anteriores.</p>';
}

// Histórico de exames solicitados no prontuário - mesma lógica de
// criptografia/descriptografia das evoluções (dado clínico, texto livre).
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

// Galeria de exames/imagens anexadas ao prontuário - miniatura pra imagem,
// ícone de PDF pra documentos, com a descrição (criptografada) legível.
function renderizarImagensExames(paciente) {
    const container = document.getElementById('pep-imagens-grid');
    if (!container) return;

    const lista = paciente.imagensExames || [];

    container.innerHTML = lista.map((item, idx) => {
        const ehImagem = (item.tipo || '').startsWith('image/');
        const descricao = item.descricaoCripto ? decriptar(item.descricaoCripto) : '';
        const preview = ehImagem
            ? `<a href="${item.url}" target="_blank" rel="noopener"><img src="${item.url}" alt="${escapeHTML(item.nomeArquivo)}"></a>`
            : `<a href="${item.url}" target="_blank" rel="noopener" class="pep-imagem-arquivo-icone"><i class="fa-solid fa-file-pdf"></i></a>`;

        return `
        <div class="pep-imagem-card">
            ${preview}
            <div class="pep-imagem-info">
                <strong title="${escapeHTML(item.nomeArquivo)}">${escapeHTML(item.nomeArquivo)}</strong>
                ${descricao ? `<span class="pep-imagem-descricao">${escapeHTML(descricao)}</span>` : ''}
                <small>${escapeHTML(item.profissional)} · ${escapeHTML(item.data)}</small>
            </div>
            <button type="button" class="btn-action btn-delete btn-excluir-imagem-exame" data-idx="${idx}" title="Excluir anexo">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>`;
    }).join('') || '<p style="color: var(--text-light); text-align: center; padding: 20px;">Nenhum exame ou imagem anexada ainda.</p>';
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
    const dataNasc = paciente.nascimento ? paciente.nascimento.split('-').reverse().join('/') : 'Não inf.';
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

    // Foto do paciente no avatar (se houver anexo) e links dos demais anexos
    const elAvatar = document.getElementById('pep-avatar');
    if (elAvatar) {
        elAvatar.innerHTML = paciente.anexos && paciente.anexos.foto
            ? `<img src="${paciente.anexos.foto}" alt="Foto de ${escapeHTML(paciente.nome)}">`
            : '<i class="fa-solid fa-hospital-user"></i>';
    }

    const elAnexosLinks = document.getElementById('pep-anexos-links');
    if (elAnexosLinks) {
        const anexos = paciente.anexos || {};
        let html = '';
        if (anexos.documento) html += `<a class="pep-badge link" href="${anexos.documento}" target="_blank" rel="noopener"><i class="fa-solid fa-id-card"></i> Documento</a>`;
        if (anexos.outros && anexos.outros.length > 0) html += `<a class="pep-badge link" href="${anexos.outros[0]}" target="_blank" rel="noopener"><i class="fa-solid fa-paperclip"></i> Outros (${anexos.outros.length})</a>`;
        elAnexosLinks.innerHTML = html;
    }
}

// ==========================================
// CADASTRO ATIVO DO PACIENTE (automático, com base na última consulta)
// ==========================================
const MESES_PARA_INATIVIDADE = 6;

function obterStatusAtividade(pacienteId) {
    // Consultas canceladas não contam como "última consulta" - agora que o
    // cancelamento não apaga mais o registro, é preciso ignorá-las aqui.
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