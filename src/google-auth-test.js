const { google } = require('googleapis');
const path = require('path');

console.log('--- INICIANDO TESTE DE AUTENTICAÇÃO DIRETA ---');

async function testAuth() {
    try {
        console.log('1. A carregar o ficheiro credentials.json...');
        const credentials = require(path.join(__dirname, 'credentials.json'));
        console.log('   ✅ Ficheiro carregado.');

        console.log('\n2. A configurar o cliente de autenticação (JWT)...');
        const auth = new google.auth.JWT(
            credentials.client_email,
            null,
            credentials.private_key,
            ['https://www.googleapis.com/auth/calendar.readonly']
        );
        console.log('   ✅ Cliente de autenticação configurado.');

        console.log('\n3. A tentar obter um token de acesso do Google...');
        await auth.authorize();
        console.log('   ✅ Token de acesso recebido com sucesso!');

        console.log('\n\n🎉 --- SUCESSO! --- 🎉');
        console.log('A sua credencial (credentials.json) é válida e conseguiu autenticar-se com o Google.');
        console.log('O problema não está na sua chave. Agora pode tentar iniciar o bot principal.');

    } catch (error) {
        console.error('\n\n❌ --- FALHA NA AUTENTICAÇÃO --- ❌');
        console.error('Ocorreu um erro ao tentar obter o token de acesso do Google.');
        console.error('\nDetalhes do Erro:');
        console.error('Código:', error.code);
        console.error('Mensagem:', error.message);
        console.error('\nIsto confirma que o problema está na configuração da sua conta Google Cloud.');
        console.error('Causas comuns: Faturação não totalmente ativa, permissões de projeto ou restrições de organização.');
    }
}

testAuth();