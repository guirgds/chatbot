const barbershopResponses = {
    // Menu principal com a nova opção "Alterar"
    welcome: (customerName) => `Olá, ${customerName}! Bem-vindo à Barbearia. O que você gostaria de fazer hoje?\n\n1 - Agendar um horário ✂️\n2 - Alterar um agendamento 🔄\n3 - Cancelar um agendamento ❌`,
    
    // Novas mensagens para o fluxo de alteração
    listAppointmentsToChange: (appointments) => {
        const formatted = appointments.map((app, i) => `${i + 1} - ${app.summary} (${new Date(app.start.dateTime).toLocaleString('pt-BR')})`).join('\n');
        return `Encontrei estes agendamentos futuros. Qual você gostaria de alterar?\n\n${formatted}\n\nDigite o número do agendamento.`;
    },
    appointmentChanged: "Ok, o agendamento anterior foi cancelado. Agora vamos remarcar.",

    // ... (resto das mensagens que já tínhamos) ...
    askForService: "Qual serviço você gostaria de agendar?\n\n1 - Corte de Cabelo\n2 - Barba\n3 - Cabelo e Barba",
    askForDay: (service) => `Ótima escolha: *${service}*. \n\nPara qual dia você gostaria de reagendar? (ex: hoje, amanhã, 25/12)`,
    showAvailableSlots: (slots) => {
        if (slots.length === 0) return "🗓️ Poxa, não tenho horários disponíveis para este dia. Por favor, escolha outra data.";
        const formattedSlots = slots.map((slot, index) => `${index + 1} - ${slot.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`).join('\n');
        return `✅ Estes são os horários disponíveis:\n${formattedSlots}\n\nPor favor, digite o número do horário que você deseja.`;
    },
    appointmentSummary: (service, date) => `*Resumo do Agendamento:*\n\n*Serviço:* ${service}\n*Data:* ${date.toLocaleString('pt-BR')}\n\nConfirmar agendamento?\n\n1 - Sim, confirmar\n2 - Não, voltar`,
    appointmentConfirmed: (service, date) => `✅ Pronto! Seu agendamento para *${service}* foi confirmado para ${date.toLocaleString('pt-BR')}. Te esperamos!`,
    appointmentNotFound: "🤔 Não encontrei nenhum agendamento futuro no seu nome.",
    confirmCancellation: (appointmentSummary, appointmentDate) => `Encontrei este agendamento:\n\n*${appointmentSummary}*\n*Data:* ${appointmentDate}\n\nDeseja mesmo cancelar?\n\n1 - Sim, cancelar\n2 - Não`,
    appointmentCancelled: "✅ Agendamento cancelado com sucesso!",
    keywordResponses: { /* ... */ },
    default: "Não entendi. Por favor, escolha uma das opções abaixo:\n\n1 - Agendar ✂️\n2 - Alterar 🔄\n3 - Cancelar ❌"
};

module.exports = barbershopResponses;