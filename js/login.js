import { showToast, comEstadoDeCarregamento } from './Ferramentas.js';

// 1. Puxa as suas conexões locais
import { auth, db } from './firebase.js';

// 2. Puxa as ferramentas de Autenticação do Google
// 2. Puxa as ferramentas de Autenticação do Google
import { signInWithEmailAndPassword, sendPasswordResetEmail, onAuthStateChanged, signOut, setPersistence, browserSessionPersistence } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
// 3. Puxa as ferramentas de Banco de Dados do Google
import { collection, query, where, getDocs, addDoc, doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';

import { clinicaState } from './state.js'; // Adicione esta linha!
import { carregarPacientes, carregarProfissionais } from './pacientes.js';
import { carregarAgendamentos, carregarBloqueios, verificarAlertasAgendamento } from './agenda.js';
import { carregarFinanceiro, carregarCustosFixos } from './financeiro.js';
import { escutarNotificacoes } from './notificacoes.js';
import { carregarEstoque } from './estoque.js';
import { carregarProcedimentos } from './procedimentos.js';
import { carregarPacotes } from './pacotes.js';
import { carregarModelosDocumentos, aplicarPermissaoModelos } from './modelosDocumentos.js';
import { liberarTravasDoAtendimento } from './atendimento.js';
import { carregarAuditoria, registrarAuditoria } from './auditoria.js';
import { atualizarAjudaPorPerfil } from './ajuda.js';
import { renderizarCardsInicio } from './NavMenu.js';
import { iniciarPainelMedico } from './painelMedico.js';

// ========================================================
// RESTRIÇÃO DE ACESSO POR IP (por clínica)
// Cada clínica pode ter sua própria lista de IPs liberados, guardada
// na coleção "clinicas" (documento com ID = clinicaId, mesmo valor já
// usado em usuarios/pacientes/etc, campo ipsPermitidos: [array de IPs]).
// Perfis Doutor(a) e recepção só entram se o IP público da conexão
// bater com essa lista - o Administrador nunca é restrito, pra sempre
// conseguir dar suporte remoto de qualquer lugar.
//
// IMPORTANTE (teste/protótipo): essa checagem roda no navegador de
// quem está logando, então funciona como um filtro de conveniência -
// alguém com conhecimento técnico pode contornar via DevTools, porque
// o app já teria uma sessão válida do Firebase Auth nesse ponto. Pra
// virar uma trava de segurança de verdade (não só de teste), o passo
// seguinte é mover essa validação pra uma Cloud Function, que enxerga
// o IP real da requisição (não um valor que o próprio cliente informa)
// e só libera um custom claim de acesso através dela.
// ========================================================
async function obterIpPublico() {
    try {
        const resposta = await fetch('https://api.ipify.org?format=json');
        const dados = await resposta.json();
        return dados.ip;
    } catch (error) {
        console.error("Erro ao obter IP público: ", error);
        return null;
    }
}

async function verificarAcessoPorIp(clinicaId, perfil) {
    // Administrador acessa de qualquer lugar, sem checagem de IP
    if (perfil === 'admin') return { permitido: true };

    try {
        const clinicaSnap = await getDoc(doc(db, "clinicas", clinicaId));

        // Clínica ainda sem restrição configurada -> não bloqueia
        // ninguém (evita travar uma clínica que nunca cadastrou IPs)
        if (!clinicaSnap.exists()) return { permitido: true };

        const ipsPermitidos = clinicaSnap.data().ipsPermitidos || [];
        if (ipsPermitidos.length === 0) return { permitido: true };

        const ipAtual = await obterIpPublico();

        // Não conseguiu descobrir o IP (sem internet, serviço externo
        // fora do ar) -> não bloqueia, pra não trancar ninguém de fora
        // por causa de um serviço de terceiro instável
        if (!ipAtual) return { permitido: true };

        return { permitido: ipsPermitidos.includes(ipAtual), ip: ipAtual };
    } catch (error) {
        console.error("Erro ao verificar restrição de IP: ", error);
        return { permitido: true };
    }
}


// ========================================================
// ENCERRAMENTO AUTOMÁTICO POR INATIVIDADE
// Protege o prontuário quando alguém esquece o computador aberto. Qualquer
// movimento de mouse, tecla, clique, rolagem ou toque reinicia a contagem.
// O Doutor(a) tem um prazo maior porque costuma deixar o Meu Painel aberto
// acompanhando a fila de pacientes, sem mexer na tela.
// ========================================================
const MINUTOS_INATIVIDADE = { admin: 30, recepcao: 30, 'Doutor(a)': 60 };
const MINUTOS_INATIVIDADE_PADRAO = 30;
const AVISO_ANTES_DO_ENCERRAMENTO_MS = 60 * 1000;

let controleInatividadeAtivo = false;
let temporizadorAvisoInatividade = null;
let temporizadorEncerramentoInatividade = null;

async function encerrarSessaoPorInatividade() {
    try {
        await liberarTravasDoAtendimento();
        await registrarAuditoria({
            acao: 'Logout',
            modulo: 'Sistema',
            descricao: 'Sessão encerrada automaticamente por inatividade'
        });
        await signOut(auth);
    } catch (error) {
        console.error("Erro ao encerrar sessão por inatividade:", error);
    } finally {
        // Recarrega para limpar a memória (clinicaState) e voltar ao login
        window.location.reload();
    }
}

function reiniciarContagemDeInatividade() {
    const minutos = MINUTOS_INATIVIDADE[clinicaState.sessao.perfil] || MINUTOS_INATIVIDADE_PADRAO;
    const total = minutos * 60 * 1000;

    clearTimeout(temporizadorAvisoInatividade);
    clearTimeout(temporizadorEncerramentoInatividade);

    temporizadorAvisoInatividade = setTimeout(() => {
        showToast('Sua sessão será encerrada em 1 minuto por inatividade. Mexa o mouse ou toque na tela para continuar.', 'warning');
    }, total - AVISO_ANTES_DO_ENCERRAMENTO_MS);

    temporizadorEncerramentoInatividade = setTimeout(encerrarSessaoPorInatividade, total);
}

function iniciarControleDeInatividade() {
    if (controleInatividadeAtivo) return;
    controleInatividadeAtivo = true;

    let ultimoRegistro = 0;
    const registrarAtividade = () => {
        const agora = Date.now();
        if (agora - ultimoRegistro < 1000) return; // não reinicia a cada pixel do mouse
        ultimoRegistro = agora;
        reiniciarContagemDeInatividade();
    };

    ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'].forEach(evento => {
        document.addEventListener(evento, registrarAtividade, { passive: true, capture: true });
    });

    reiniciarContagemDeInatividade();
}

export function initAuth() {
    const formLogin = document.getElementById('form-login');
    const loginScreen = document.getElementById('login-screen');
    const btnSolicitarAcesso = document.getElementById('btn-solicitar-acesso');

    // 1. Observador de Sessão ÚNICO E INTELIGENTE
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            // Vai no banco e busca o perfil e a clínica de quem está logado
            // O documento do usuário tem como ID o próprio UID do Auth (as regras
            // do Firestore dependem disso pra saber quem é quem)
            const perfilSnap = await getDoc(doc(db, "usuarios", user.uid));
            
            if (perfilSnap.exists()) {
                const dadosUsuario = perfilSnap.data();

                const acesso = await verificarAcessoPorIp(dadosUsuario.clinicaId, dadosUsuario.perfil);
                if (!acesso.permitido) {
                    showToast('Acesso permitido apenas dentro da clínica. Fale com o administrador.', 'error');
                    await signOut(auth);
                    return;
                }

                // Restaura a memória do sistema ANTES de carregar as tabelas
                clinicaState.sessao.uid = user.uid;
                clinicaState.sessao.email = user.email;
                clinicaState.sessao.nome = dadosUsuario.nome;
                clinicaState.sessao.perfil = dadosUsuario.perfil;
                clinicaState.sessao.clinicaId = dadosUsuario.clinicaId;

                // Esconde as telas que não pode ver
                aplicarPermissoesDeTela(); 

                // AGORA SIM, com a clínica salva na memória, ele carrega os dados certos!
                await carregarProfissionais();
                await carregarAgendamentos();
                await carregarBloqueios();
                verificarAlertasAgendamento();
                escutarNotificacoes();
                // Pacientes carrega depois da agenda: o status "Ativo/Inativo" da
                // tabela é calculado a partir da última consulta de cada paciente.
                await carregarPacientes();
                // Só carrega o que o perfil pode ler (as regras do Firestore
                // bloqueiam o resto e gerariam erro na tela):
                //  - Financeiro/Custos Fixos: só admin (recepção só lança)
                //  - Estoque: admin e recepção
                const perfilLogado = clinicaState.sessao.perfil;
                if (perfilLogado === 'admin') {
                    await carregarCustosFixos();
                    await carregarFinanceiro();
                }
                if (perfilLogado === 'admin' || perfilLogado === 'recepcao') {
                    await carregarEstoque();
                }
                await carregarProcedimentos();
                await carregarPacotes();
                // Modelos de documentos (receituários, laudos...): só quem
                // usa o prontuário precisa deles
                if (perfilLogado === 'admin' || perfilLogado === 'Doutor(a)') {
                    aplicarPermissaoModelos();
                    await carregarModelosDocumentos();
                }

                // Painel do médico: depende de sessão + profissionais já
                // carregados (vínculo login -> cadastro da Equipe). Ao
                // entrar, o Doutor(a) já cai no painel em vez do Início.
                if (clinicaState.sessao.perfil === 'Doutor(a)') {
                    iniciarPainelMedico();
                    document.querySelector('.menu-btn[data-target="painel-medico"]')?.click();
                }

                // Log de auditoria é restrito ao Administrador - evita leitura
                // desnecessária no Firestore para quem nunca vai ver a tela.
                if (clinicaState.sessao.perfil === 'admin') {
                    await carregarAuditoria();
                }
                
                // Remove a tela de login
                loginScreen.classList.remove('active');
                loginScreen.style.display = 'none';
            } else {
                // Prevenção de segurança se o usuário foi deletado do banco
                await signOut(auth);
            }
        } else {
            // Sem sessão, mostramos a tela de login
            loginScreen.style.display = 'flex';
            setTimeout(() => loginScreen.classList.add('active'), 10);
        }
    });

    // 2. Fluxo de Login Real
    formLogin.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const email = document.getElementById('login-email').value;
        const senha = document.getElementById('login-senha').value;
        const btn = formLogin.querySelector('button[type="submit"]');

        await comEstadoDeCarregamento(btn, 'Autenticando...', async () => {
            try {
                // 1. Avisa o Firebase que a sessão morre se a aba for fechada
                await setPersistence(auth, browserSessionPersistence);

                // 2. Envia as credenciais para o Firebase
                const userCredential = await signInWithEmailAndPassword(auth, email, senha);
                const user = userCredential.user;

                // 2. Procura qual é o perfil desse e-mail na sua coleção de controle
                const perfilSnap = await getDoc(doc(db, "usuarios", user.uid));
                
                if (!perfilSnap.exists()) {
                    // Se o e-mail não estiver na tabela de permissões do Firebase, bloqueia na hora!
                    showToast('Acesso negado. Usuário sem perfil configurado no sistema.', 'error');
                    await signOut(auth);
                    return; 
                }

                // Pega as permissões que você configurou manualmente no Firebase
                const dadosUsuario = perfilSnap.data();

                // Checagem de IP - roda antes de liberar qualquer coisa. Se
                // falhar, derruba a sessão do Firebase Auth que acabou de
                // ser criada pelo signInWithEmailAndPassword logo acima.
                const acesso = await verificarAcessoPorIp(dadosUsuario.clinicaId, dadosUsuario.perfil);
                if (!acesso.permitido) {
                    showToast('Acesso permitido apenas dentro da clínica.', 'error');
                    await signOut(auth);
                    return;
                }

                // 3. Salva na memória do sistema
                clinicaState.sessao.uid = user.uid;
                clinicaState.sessao.email = user.email;
                clinicaState.sessao.nome = dadosUsuario.nome;
                clinicaState.sessao.perfil = dadosUsuario.perfil;
                clinicaState.sessao.clinicaId = dadosUsuario.clinicaId;

                // 4. Aplica as travas visuais (Oculta os menus)
                aplicarPermissoesDeTela();

                // Assinatura digital do acesso - feito depois de aplicarPermissoesDeTela
                // porque já precisa de sessao.nome/perfil/clinicaId preenchidos
                await registrarAuditoria({
                    acao: 'Login',
                    modulo: 'Sistema',
                    descricao: `Login realizado (${dadosUsuario.perfil})`
                });

                loginScreen.style.opacity = '0';
                loginScreen.style.transition = 'opacity 0.5s ease';
                
                setTimeout(() => {
                    loginScreen.classList.remove('active');
                    loginScreen.style.display = 'none';
                    loginScreen.style.opacity = '1';
                }, 500);
                
                showToast(`Bem-vindo, ${dadosUsuario.nome}! Acesso: ${dadosUsuario.perfil.toUpperCase()}`, 'success');

            } catch (error) {
                console.error("Erro no login:", error.code);
                showToast('Credenciais inválidas ou acesso negado.', 'error');
            }
        });
    });

    // ESQUECI MINHA SENHA
    // Usa o e-mail já digitado no campo de login. O Firebase envia o link de
    // redefinição (em português, ver languageCode abaixo). A mensagem é sempre
    // a mesma, exista a conta ou não, pra ninguém usar essa tela pra descobrir
    // quais e-mails estão cadastrados. Intervalo de 60s entre pedidos evita
    // disparo repetido de e-mails.
    auth.languageCode = 'pt-BR';
    const btnEsqueciSenha = document.getElementById('btn-esqueci-senha');
    let ultimoPedidoSenha = 0;

    if (btnEsqueciSenha) {
        btnEsqueciSenha.addEventListener('click', async () => {
            const campoEmail = document.getElementById('login-email');
            const email = campoEmail.value.trim();

            if (!email || !campoEmail.checkValidity()) {
                showToast('Digite seu e-mail no campo acima e clique em "Esqueci minha senha" de novo.', 'warning');
                campoEmail.focus();
                return;
            }

            const restante = 60000 - (Date.now() - ultimoPedidoSenha);
            if (restante > 0) {
                showToast(`Aguarde ${Math.ceil(restante / 1000)}s para pedir um novo link.`, 'warning');
                return;
            }

            await comEstadoDeCarregamento(btnEsqueciSenha, 'Enviando...', async () => {
                try {
                    await sendPasswordResetEmail(auth, email);
                    ultimoPedidoSenha = Date.now();
                } catch (error) {
                    console.error("Erro ao enviar redefinição de senha:", error.code);
                    // Só avisa de erro se for problema de conexão ou excesso de pedidos;
                    // conta inexistente fica com a mesma mensagem de sucesso (de propósito)
                    if (error.code === 'auth/network-request-failed') {
                        showToast('Sem conexão. Verifique sua internet e tente de novo.', 'error');
                        return;
                    }
                    if (error.code === 'auth/too-many-requests') {
                        showToast('Muitas tentativas. Aguarde alguns minutos e tente de novo.', 'error');
                        return;
                    }
                    ultimoPedidoSenha = Date.now();
                }
                showToast('Se este e-mail estiver cadastrado, você receberá um link para criar uma nova senha. Verifique também o spam.', 'success');
            });
        });
    }

    btnSolicitarAcesso.addEventListener('click', () => {
        const mensagem = encodeURIComponent("Olá JS Ferreira, gostaria de solicitar minhas credenciais de acesso ao sistema ERP.");
        window.open(`https://wa.me/5575981701297?text=${mensagem}`, '_blank');
    });

    // 3. Botão de Logout
    const btnLogout = document.getElementById('btn-logout');
    if (btnLogout) {
        btnLogout.addEventListener('click', async () => {
            try {
                // Registra a saída ANTES do signOut - depois disso a sessão
                // (nome/perfil/clinicaId) é zerada pelo reload da página.
                await liberarTravasDoAtendimento();
                await registrarAuditoria({
                    acao: 'Logout',
                    modulo: 'Sistema',
                    descricao: 'Encerramento de sessão'
                });

                // Informa ao Firebase para destruir a sessão atual
                await signOut(auth);
                
                // Recarrega a página forçadamente para limpar toda a memória RAM (clinicaState)
                // e garantir que o próximo usuário pegue o sistema do zero.
                window.location.reload(); 
            } catch (error) {
                console.error("Erro ao fazer logout:", error);
                showToast('Erro ao tentar encerrar a sessão.', 'error');
            }
        });
    }
}

// === MOTOR DE CONTROLE DE ACESSO (RBAC) ===
function aplicarPermissoesDeTela() {
    // Perfil já definido aqui: começa a contar a inatividade da sessão
    iniciarControleDeInatividade();

    const perfil = clinicaState.sessao.perfil;
    const userNameEl = document.getElementById('profile-user-name');
    
    if (userNameEl) {
        let nomeFormatado = clinicaState.sessao.nome;
        userNameEl.textContent = 'Olá, ' + nomeFormatado.charAt(0).toUpperCase() + nomeFormatado.slice(1);
    }

    // Pega todos os botões do menu lateral
    const btnDash = document.querySelector('.menu-btn[data-target="dashboard"]');
    const btnFin = document.querySelector('.menu-btn[data-target="financeiro"]');
    const btnEst = document.querySelector('.menu-btn[data-target="estoque"]');
    const btnAudit = document.getElementById('btn-menu-auditoria');
    const btnPainelMedico = document.getElementById('btn-menu-painel-medico');

    // Dentro de Pacientes & Prontuários: o Doutor(a) só consulta - cadastro
    // de paciente novo e a Área da Equipe (gestão de outros profissionais)
    // não fazem parte da rotina dele, então ficam ocultos pra esse perfil.
    const btnNovoPaciente = document.getElementById('btn-novo-paciente');
    const btnHubProfissionais = document.getElementById('btn-hub-profissionais');

    // Sub-áreas de dentro do Financeiro: a recepção tem uma tela própria e
    // simplificada (só o formulário de lançamento) - o hub com Livro Caixa
    // completo e Custos Fixos é exclusivo do Administrador.
    const hubFinanceiro = document.getElementById('hub-financeiro');
    const areaLivroCaixa = document.getElementById('area-livro-caixa');
    const areaCustosFixos = document.getElementById('area-custos-fixos');
    const formFinanceiroRecepcao = document.getElementById('financeiro-recepcao-form');
    
    // Reseta todos para visível primeiro
    if(btnDash) btnDash.style.display = 'flex';
    if(btnFin) btnFin.style.display = 'flex';
    if(btnEst) btnEst.style.display = 'flex';
    if(btnNovoPaciente) btnNovoPaciente.style.display = '';
    if(btnHubProfissionais) btnHubProfissionais.style.display = '';
    if(hubFinanceiro) hubFinanceiro.style.display = '';
    if(formFinanceiroRecepcao) formFinanceiroRecepcao.style.display = 'none';
    // Auditoria é o oposto dos outros: só aparece para o Administrador
    if(btnAudit) btnAudit.style.display = 'none';
    // "Meu Painel" é o oposto também: só o Doutor(a) enxerga
    if(btnPainelMedico) btnPainelMedico.style.display = 'none';

    // Regras de Bloqueio
    if (perfil === 'Doutor(a)') {
        if(btnPainelMedico) btnPainelMedico.style.display = 'flex';
        // Médico não vê finanças, nem estoque, nem dashboard geral
        if(btnDash) btnDash.style.display = 'none';
        if(btnFin) btnFin.style.display = 'none';
        if(btnEst) btnEst.style.display = 'none';

        // Nem cadastro de paciente novo, nem gestão da equipe - ele consulta
        // prontuário, não administra cadastro (ver pacientes.js, trava real
        // no clique do botão pro caso de alguém forçar via DevTools)
        if(btnNovoPaciente) btnNovoPaciente.style.display = 'none';
        if(btnHubProfissionais) btnHubProfissionais.style.display = 'none';
    } 
    else if (perfil === 'recepcao') {
        // Recepção não vê o Dashboard/DRE (é análise gerencial).
        if(btnDash) btnDash.style.display = 'none';
        
        // Agora a recepção VÊ o hub financeiro (Livro Caixa)
        if(hubFinanceiro) hubFinanceiro.style.display = 'flex';
        // Mas ela só LANÇA, não CONSULTA: o bloco com dashboard, filtros e
        // tabela do Livro Caixa fica oculto, e um aviso aparece no lugar.
        const livroCaixaConsulta = document.getElementById('livro-caixa-consulta');
        const livroCaixaAvisoRecepcao = document.getElementById('livro-caixa-aviso-recepcao');
        if(livroCaixaConsulta) livroCaixaConsulta.style.display = 'none';
        if(livroCaixaAvisoRecepcao) livroCaixaAvisoRecepcao.style.display = 'block';
        // Mas escondemos o botão de Custos Fixos (Saídas) dela
        const btnCustos = document.getElementById('btn-hub-custos-fixos');
        if(btnCustos) btnCustos.style.display = 'none';
        // E o botão de editar a Tabela de Procedimentos - ela escolhe o
        // procedimento na Agenda, mas quem define/edita valor é o admin
        const btnProcedimentos = document.getElementById('btn-hub-procedimentos');
        if(btnProcedimentos) btnProcedimentos.style.display = 'none';
        // Idem pro cadastro de Pacotes - a recepção usa o atalho de pacote
        // dentro do lançamento, mas não gerencia o catálogo (nome/valor)
        const btnPacotes = document.getElementById('btn-hub-pacotes');
        if(btnPacotes) btnPacotes.style.display = 'none';
        
        // Removemos o "Caixa Cego" antigo, pois agora ela usa o Livro Caixa oficial
        if(formFinanceiroRecepcao) formFinanceiroRecepcao.style.display = 'none';
    }
    else if (perfil === 'admin') {
        // Só o Administrador tem acesso ao log de auditoria
        if(btnAudit) btnAudit.style.display = 'flex';
    }

    // Re-renderiza a Central de Ajuda já filtrada para este perfil - no
    // carregamento inicial da página (antes do login) ela tinha sido
    // montada com todos os módulos, por ainda não saber quem ia entrar.
    atualizarAjudaPorPerfil();

    // Tela de Início: cards de atalho pra cada módulo que esse perfil
    // efetivamente enxerga no menu lateral - montada só agora que todas as
    // travas de visibilidade acima já rodaram.
    renderizarCardsInicio();
}