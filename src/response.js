const barbershopResponses = {
    welcome: (customerName) => `Olá, ${customerName}! Bem-vindo à Barbearia. O que você gostaria de agendar hoje?\n\n1 - Corte de Cabelo\n2 - Barba\n3 - Cabelo e Barba`,
    
    serviceConfirmation: (service) => `Ótima escolha! Você selecionou: *${service}*.\n\nPor favor, me diga o melhor dia e horário para você.`,
    
    keywordResponses: {
        // Respostas para a palavra-chave "preço" ou "valor"
        preco: "Nossos preços são:\n- Corte de Cabelo: R$ 30,00\n- Barba: R$ 25,00\n- Cabelo e Barba: R$ 50,00",
        
        // Respostas para a palavra-chave "horário" ou "aberto"
        horario: "Nosso horário de funcionamento é de Segunda a Sábado, das 9h às 20h.",
        
        // Respostas para a palavra-chave "endereço" ou "onde"
        endereco: "Nós ficamos na Rua da Barbearia, nº 123, Bairro Centro.",
        
        // Resposta para agradecimentos
        obrigado: "De nada! Se precisar de mais alguma coisa, é só chamar."
    },

    default: "Escolha uma das opções de agendamento abaixo:\n\n1 - Corte de Cabelo\n2 - Barba\n3 - Cabelo e Barba"
};

module.exports = barbershopResponses;