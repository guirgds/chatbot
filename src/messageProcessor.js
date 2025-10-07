const responses = require('./responses');

function processMessage(message) {
    const lowerCaseMessage = message.toLowerCase();

    // Palavras-chave e suas respostas correspondentes
    const rules = {
        preco: ['preço', 'valor', 'custa', 'preços'],
        horario: ['horário', 'atendimento', 'aberto', 'abrem', 'funciona'],
        endereco: ['endereço', 'onde', 'local', 'rua'],
        obrigado: ['obrigado', 'obg', 'valeu']
    };

    // Procura por uma palavra-chave na mensagem do usuário
    for (const key in rules) {
        // A função .some() verifica se pelo menos uma palavra-chave da lista está na mensagem
        if (rules[key].some(keyword => lowerCaseMessage.includes(keyword))) {
            return responses.keywordResponses[key];
        }
    }

    // Se nenhuma regra corresponder, retorna a resposta padrão
    return responses.default;
}

module.exports = { processMessage };