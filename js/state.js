// Exportamos o estado para que outros arquivos possam acessar
export const clinicaState = {
    // Nova área: Dados da Sessão Atual
    sessao: {
        uid: null,
        email: null,
        nome: null,
        perfil: null,      // 'admin', 'Doutor(a)' ou 'recepcao'
        clinicaId: null    // Identificador único da clínica pagante
    },

// Marcadores de funcionalidades ativas para a clínica logada
    features: {},
    
    // Áreas de dados gerais
    pacientes: [],
    profissionais: [],
    estoque: [],
    procedimentos: [],
    pacotes: [],
    modelosDocumentos: [],
    financeiro: { lancamentos: [], custosFixos: [] },
    agenda: { agendamentos: [], bloqueios: [] },
    notificacoes: [],
    auditoria: []
};