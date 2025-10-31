/**
 * Processa a mensagem do utilizador para encontrar respostas baseadas em palavras-chave específicas do cliente.
 * @param {string} message - A mensagem de texto do utilizador.
 * @param {object} clientConfig - O objeto de configuração carregado do banco de dados para este cliente.
 * Espera-se que contenha algo como: clientConfig.keywordRules e clientConfig.keywordResponses.
 * @returns {string|null} A resposta correspondente à palavra-chave ou null se nenhuma for encontrada.
 */
function processMessage(message, clientConfig) {
    // Verificar se as configurações necessárias existem
    if (!clientConfig || !clientConfig.keywordRules || !clientConfig.keywordResponses) {
        return null;
    }

    const lowerCaseMessage = message.toLowerCase();
    const rules = clientConfig.keywordRules; // Usar as regras do cliente
    const responses = clientConfig.keywordResponses; // Usar as respostas do cliente

    // Procura por uma palavra-chave na mensagem do utilizador, usando as regras do cliente
    for (const key in rules) {
        if (rules[key] && Array.isArray(rules[key]) && responses[key]) {
            // A função .some() verifica se pelo menos uma palavra-chave da lista está na mensagem
            if (rules[key].some(keyword => lowerCaseMessage.includes(keyword.toLowerCase()))) {
                return responses[key]; // Retorna a resposta específica do cliente
            }
        }
    }

    return null;
}

module.exports = { processMessage };