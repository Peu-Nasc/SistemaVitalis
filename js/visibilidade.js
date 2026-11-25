import { clinicaState } from './state.js';

// ========================================================
// VISIBILIDADE POR PROFISSIONAL (LGPD / agenda compartilhada)
//
// Regras:
//  - admin: vê tudo.
//  - recepcao sem profissionaisPermitidos: vê tudo.
//  - Doutor(a): vê só a própria agenda (+ as agendas em
//    profissionaisPermitidos, se houver).
//  - Qualquer perfil não-admin COM profissionaisPermitidos (ex.: Ricardo,
//    assistente de triagem do Dr. Haroldo): vê só essas agendas.
//
// Campos lidos de /usuarios/{uid} (ver login.js):
//  - profissionalId: id do cadastro do profissional (coleção "profissionais")
//  - profissionaisPermitidos: [idProf, ...] agendas compartilhadas
// ========================================================

// Id do cadastro de profissional do usuário logado. Usa o campo explícito
// do usuário; se não existir ainda, cai no vínculo por nome (o mesmo
// critério já usado no prontuário).
export function idProfissionalDaSessao() {
    const s = clinicaState.sessao;
    if (s.profissionalId) return String(s.profissionalId);

    const nome = (s.nome || '').trim().toLowerCase();
    if (!nome) return null;
    const prof = clinicaState.profissionais.find(p => (p.nome || '').trim().toLowerCase() === nome);
    return prof ? String(prof.id) : null;
}

// Retorna um Set com os ids de profissionais cujas agendas o usuário pode
// ver, ou null quando não há restrição (vê todas).
export function idsAgendasVisiveis() {
    const { perfil, profissionaisPermitidos } = clinicaState.sessao;
    const extras = (profissionaisPermitidos || []).map(String);

    if (perfil === 'admin') return null;

    if (perfil === 'Doutor(a)') {
        const ids = new Set(extras);
        const proprio = idProfissionalDaSessao();
        if (proprio) ids.add(proprio);
        return ids; // vazio = não vê ninguém (falha fechada)
    }

    return extras.length > 0 ? new Set(extras) : null;
}

export function agendamentosVisiveis() {
    const ids = idsAgendasVisiveis();
    const todos = clinicaState.agenda.agendamentos;
    return ids ? todos.filter(a => ids.has(String(a.profId))) : todos;
}

// Pacientes que têm (ou já tiveram) agendamento não cancelado nas agendas
// visíveis para o usuário.
export function pacientesVisiveis() {
    const ids = idsAgendasVisiveis();
    if (!ids) return clinicaState.pacientes;

    const idsPacientes = new Set(
        clinicaState.agenda.agendamentos
            .filter(a => a.status !== 'cancelado' && ids.has(String(a.profId)))
            .map(a => String(a.pacId))
    );
    return clinicaState.pacientes.filter(p => idsPacientes.has(String(p.id)));
}