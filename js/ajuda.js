import { clinicaState } from './state.js';

// ========================================================
// AJUDA / TUTORIAL DO SISTEMA
// Central de dúvidas rápidas por módulo, pra funcionário ou
// cliente conseguir entender uma funcionalidade sem precisar
// mandar mensagem direto pro suporte. Cada pergunta é um
// <details> nativo do HTML (abre/fecha sozinho) - o JS aqui só
// cuida de renderizar o conteúdo e filtrar pela busca.
//
// VISIBILIDADE POR PERFIL: cada módulo só aparece pra quem
// realmente enxerga aquela tela no menu lateral (mesma regra
// de aplicarPermissoesDeTela em login.js). Assim a recepção e
// o(a) Doutor(a) não veem explicação de telas que nem têm
// acesso - só o que usam no dia a dia.
// ========================================================

const TOPICOS_AJUDA = [
    {
        modulo: 'Dashboard & DRE',
        icone: 'fa-solid fa-chart-line',
        perfis: ['admin'],
        perguntas: [
            {
                titulo: 'O que é o DRE que aparece no Dashboard?',
                resposta: 'É o Demonstrativo de Resultado do Exercício: um resumo de tudo que entrou (receitas) e saiu (despesas e custos fixos) no período selecionado, mostrando o lucro líquido da clínica.'
            },
            {
                titulo: 'Como eu troco o período analisado?',
                resposta: 'Use o seletor "Últimos 30 Dias" no topo da tela do Dashboard. Dá pra ver só hoje, ontem, os últimos 7 dias, todo o período ou escolher uma data específica.'
            },
            {
                titulo: 'Por que não vejo essa tela no meu login?',
                resposta: 'O Dashboard mostra dados gerenciais e financeiros da clínica inteira, por isso só fica visível para o perfil Administrador. Perfis de Doutor(a) e Recepção não têm acesso a essa análise.'
            }
        ]
    },
    {
        modulo: 'Agenda',
        icone: 'fa-regular fa-calendar-days',
        perfis: ['admin', 'Doutor(a)', 'recepcao'],
        perguntas: [
            {
                titulo: 'Como marco uma nova consulta?',
                resposta: 'Na tela de Agenda, clique no horário desejado, escolha o paciente, o profissional e o tipo de atendimento e salve. O agendamento entra com status "Agendado".'
            },
            {
                titulo: 'O que significa cada status da consulta?',
                resposta: 'Agendado: consulta marcada, ainda sem confirmação. Confirmado: paciente confirmou presença. Aguardando Atendimento: paciente já chegou à clínica. Cancelado: consulta não vai acontecer. Concluído: atendimento já foi realizado.'
            },
            {
                titulo: 'Como confirmo uma consulta?',
                resposta: 'Abra o agendamento e marque como "Confirmado". Nessa etapa também dá pra registrar se a confirmação foi enviada por WhatsApp, se o pagamento já foi feito e se o paciente já chegou.'
            }
        ]
    },
    {
        modulo: 'Pacientes & Prontuários',
        icone: 'fa-solid fa-users',
        perfis: ['admin', 'Doutor(a)', 'recepcao'],
        perguntas: [
            {
                titulo: 'Onde vejo o histórico de um paciente?',
                resposta: 'Entre na área de Pacientes, clique no paciente desejado para abrir o prontuário. Lá ficam os atendimentos anteriores, exames solicitados e encaminhamentos.'
            },
            {
                titulo: 'Como marco um paciente como Ativo ou Inativo?',
                resposta: 'Esse status é calculado automaticamente pelo sistema com base na data da última consulta do paciente - não precisa marcar manualmente.'
            }
        ]
    },
    {
        modulo: 'Estoque (Anvisa)',
        icone: 'fa-solid fa-boxes-stacked',
        perfis: ['admin', 'recepcao'],
        perguntas: [
            {
                titulo: 'Como registro a entrada de um novo item?',
                resposta: 'Clique em "Novo Item" na tela de Estoque, preencha código, nome, lote, validade, quantidade e o estoque mínimo desejado, e salve.'
            },
            {
                titulo: 'O que significam os avisos de "Estoque Baixo" e "Vencido"?',
                resposta: '"Estoque Baixo" aparece quando a quantidade atual chega no (ou fica abaixo do) mínimo cadastrado para aquele item. "Vencido" ou "Vence em X dias" avisam sobre a validade do lote, com alerta antecipado de até 30 dias.'
            },
            {
                titulo: 'Os botões "+" e "-" na tabela fazem o quê?',
                resposta: 'Ajustam rapidamente a quantidade daquele lote em 1 unidade, sem precisar abrir o formulário completo - útil no dia a dia de uso de materiais.'
            }
        ]
    },
    {
        modulo: 'Financeiro',
        icone: 'fa-solid fa-cash-register',
        perfis: ['admin', 'recepcao'],
        perguntas: [
            {
                titulo: 'Como lanço um pagamento recebido?',
                resposta: 'Se você é da Recepção, use o formulário simplificado de lançamento na tela de Financeiro. Se for Administrador, o lançamento também pode ser feito pelo Livro Caixa completo, com mais filtros e histórico.'
            },
            {
                titulo: 'O que são os Custos Fixos?',
                resposta: 'São as despesas recorrentes da clínica (aluguel, contas, salários, etc.), cadastradas separadamente das entradas do dia a dia, e usadas no cálculo do DRE no Dashboard.'
            },
            {
                titulo: 'Como exporto o relatório financeiro?',
                resposta: 'No Livro Caixa (visível para o Administrador), use a opção de exportação para gerar uma planilha Excel com receitas e despesas separadas por forma de pagamento, totais e lucro líquido.'
            },
            {
                titulo: 'O que é a Tabela de Procedimentos?',
                resposta: 'É onde ficam cadastrados os valores cobrados por tipo de atendimento (ex: sessão de Psicologia, Terapia Ocupacional...). Só o Administrador cadastra e edita os valores; esses valores depois aparecem automaticamente na hora de marcar uma consulta na Agenda, sem precisar digitar preço na mão. Também é possível cadastrar um valor diferente para um profissional específico, se ele cobrar fora do padrão.'
            },
            {
                titulo: 'O que são os Pacotes de Atendimento?',
                resposta: 'É um catálogo de pacotes com preço fechado (ex: atendimento multidisciplinar semanal), cadastrado pelo Administrador. Na hora de lançar um pagamento no Livro Caixa, dá pra escolher "Usar um pacote fechado?" pra preencher automaticamente a descrição e o valor - só o nome do paciente precisa ser ajustado antes de salvar.'
            }
        ]
    },
    {
        modulo: 'Notificações',
        icone: 'fa-solid fa-bell',
        perfis: ['admin', 'Doutor(a)', 'recepcao'],
        perguntas: [
            {
                titulo: 'De onde vêm as notificações?',
                resposta: 'O sistema cria notificações automaticamente para situações que precisam de atenção, como retorno pendente, exame solicitado ou pagamento pendente de confirmação.'
            },
            {
                titulo: 'O que é aquele popup perguntando se o pagamento foi feito?',
                resposta: 'Quando surge uma pendência de pagamento, a Recepção recebe um popup na hora perguntando se o cliente já pagou. Ao confirmar, o pagamento fica registrado como concluído e a ação entra na Auditoria automaticamente.'
            }
        ]
    },
    {
        modulo: 'Auditoria',
        icone: 'fa-solid fa-file-signature',
        perfis: ['admin'],
        perguntas: [
            {
                titulo: 'Para que serve a tela de Auditoria?',
                resposta: 'É o histórico completo de ações relevantes do sistema: quem criou, editou ou excluiu algo, além de logins e logouts, com data e hora de cada ação.'
            },
            {
                titulo: 'Por que só o Administrador vê essa tela?',
                resposta: 'Por segurança: o log de auditoria é uma trilha de assinatura digital de tudo que acontece na clínica, então o acesso fica restrito ao perfil Administrador.'
            }
        ]
    },
    {
        modulo: 'Acesso e Segurança',
        icone: 'fa-solid fa-shield-halved',
        perfis: ['admin', 'Doutor(a)', 'recepcao'],
        perguntas: [
            {
                titulo: 'Esqueci minha senha, o que eu faço?',
                resposta: 'Use o botão "Solicitar Acesso" na tela de login para entrar em contato direto pelo WhatsApp e pedir novas credenciais.'
            },
            {
                titulo: 'Por que preciso logar de novo depois de fechar a aba?',
                resposta: 'Por segurança, a sessão fica vinculada à aba do navegador. Assim, se alguém logar com outro perfil em outra aba, isso não afeta quem já está com uma sessão aberta.'
            }
        ]
    }
];

// Retorna só os módulos que o perfil logado tem permissão de ver (mesmo
// critério do menu lateral). Se por algum motivo a sessão ainda não tiver
// perfil definido, não filtra nada - evita a tela ficar vazia antes do login.
function topicosPermitidosParaPerfil() {
    const perfil = clinicaState.sessao.perfil;
    if (!perfil) return TOPICOS_AJUDA;
    return TOPICOS_AJUDA.filter(modulo => modulo.perfis.includes(perfil));
}

// Chamada por login.js (dentro de aplicarPermissoesDeTela) assim que o
// perfil da sessão é conhecido, pra re-renderizar a lista já filtrada -
// no primeiro carregamento da página (antes do login) ainda não dá pra
// saber quem está entrando.
export function atualizarAjudaPorPerfil() {
    const busca = document.getElementById('search-ajuda');
    if (busca) busca.value = '';
    renderizarTopicos(topicosPermitidosParaPerfil());
}

export function initAjuda() {
    renderizarTopicos(topicosPermitidosParaPerfil());

    const busca = document.getElementById('search-ajuda');
    if (busca) {
        busca.addEventListener('input', () => {
            const termo = busca.value.toLowerCase().trim();
            const topicosDoPerfil = topicosPermitidosParaPerfil();

            if (!termo) {
                renderizarTopicos(topicosDoPerfil);
                return;
            }

            // Mantém só as perguntas que batem com a busca, e some com o
            // módulo inteiro se nenhuma pergunta dele sobrar
            const filtrados = topicosDoPerfil
                .map(modulo => ({
                    ...modulo,
                    perguntas: modulo.perguntas.filter(p =>
                        p.titulo.toLowerCase().includes(termo) ||
                        p.resposta.toLowerCase().includes(termo)
                    )
                }))
                .filter(modulo => modulo.perguntas.length > 0);

            renderizarTopicos(filtrados, termo);
        });
    }
}

function renderizarTopicos(topicos, termoBusca = '') {
    const container = document.getElementById('ajuda-lista');
    if (!container) return;

    if (topicos.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:#6C757D; padding:30px;">Nenhum resultado encontrado para essa busca.</p>';
        return;
    }

    // Quando o usuário está buscando, os itens já abrem direto (open) pra
    // não precisar clicar de novo pra ver se a resposta bate com o que quer
    container.innerHTML = topicos.map(modulo => `
        <div class="ajuda-modulo">
            <h3 class="ajuda-modulo-titulo"><i class="${modulo.icone}"></i> ${modulo.modulo}</h3>
            ${modulo.perguntas.map(p => `
                <details class="ajuda-item"${termoBusca ? ' open' : ''}>
                    <summary>${p.titulo}</summary>
                    <div class="ajuda-resposta">${p.resposta}</div>
                </details>
            `).join('')}
        </div>
    `).join('');
}