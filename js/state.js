// Exportamos o estado para que outros arquivos possam acessar
export const clinicaState = {
    // Nova área: Dados da Sessão Atual
    sessao: {
        uid: null,
        email: null,
        nome: null,
        perfil: null,
        clinicaId: null,
        profissionalId: null,
        profissionaisPermitidos: [],
        ehTriagem: false, // true para assistentes que fazem pré-consulta/triagem (ex: Ricardo)
        triagemConfig: {
            modelo: 'geral',
            verHistorico: true,
            verAntecedentes: true,
            verImagens: true
        }
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