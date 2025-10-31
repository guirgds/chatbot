const logger = require('./logger');

/** 🎨 Dicionário de emojis para padronizar estilo */
const emoji = {
    clock: "🕒",
    calendar: "📅",
    check: "✅",
    warn: "⚠️",
    cross: "❌",
    repeat: "🔄",
    scissor: "💈",
};

/**
 *Gera listas numeradas de serviços, agendamentos ou profissionais.
 */
function generateNumberedList(items, type = 'service') {
    if (!items || !Array.isArray(items) || items.length === 0) {
        return type === 'service'
            ? '(Nenhum serviço configurado)'
            : '(Nenhum agendamento encontrado)';
    }

    const currencyFormatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

    return items.map((item, index) => {
        try {
            if (type === 'service' || type === 'professional') {
                const name = item?.name || 'Serviço';
                let priceStr = '';
                if (item?.price != null && !Number.isNaN(Number(item.price))) {
                    priceStr = ` (${currencyFormatter.format(Number(item.price))})`;
                }
                return `${index + 1}️⃣ ${name}${priceStr}`;
            } else if (type === 'appointment') {
                const rawDate = item?.start?.dateTime || item?.start?.date;
                const dateStr = rawDate ? new Date(rawDate).toLocaleString('pt-BR') : 'Data indefinida';
                const summary = item?.summary || 'Agendamento';
                return `${index + 1}️⃣ ${summary} (${dateStr})`;
            }
            return `${index + 1}️⃣ ${JSON.stringify(item)}`;
        } catch (err) {
            logger.error('Erro ao formatar item', { index, err: err.message });
            return `${index + 1}️⃣ (Erro ao exibir item)`;
        }
    }).join('\n');
}

/**
 *Gera todas as respostas dinâmicas e personalizadas com base nas configurações do cliente.
 */
function getResponses(clientConfig = {}) {
    const cfg = clientConfig.config || clientConfig;
    const clientResponses = cfg.responses || {};
    const businessName = cfg.business_name || cfg.businessName || "o estabelecimento";
    const servicesOrCategories = Array.isArray(cfg.categories)
        ? cfg.categories
        : (Array.isArray(cfg.services) ? cfg.services : []);

    const serviceListString = generateNumberedList(servicesOrCategories, 'service');

    const defaults = {
        welcome: (customerName, businessName, serviceListString) => {
            let msg = `Olá, ${customerName}! Bem-vindo(a) à ${businessName} ${emoji.scissor}\n\n`;
            msg += `Para agendar, envie o **NÚMERO do serviço** desejado:\n\n${serviceListString}`;
            msg += `\n\n*Outras Opções:*\n*A* - Alterar um agendamento ${emoji.repeat}\n*C* - Cancelar um agendamento ${emoji.cross}`;
            return msg;
        },

        askForService: (listStr) => `Qual serviço você gostaria de agendar? ${emoji.scissor}\n\n${listStr}`,

        askForProfessional: (professionals, categoryName) => {
            const professionalList = generateNumberedList(professionals, 'professional');
            return `Você escolheu *${categoryName}*.\nEnvie o **NÚMERO do profissional** desejado:\n\n${professionalList}`;
        },

        askForDay: (service) =>
            `Ótima escolha: *${service}*! ${emoji.calendar}\nPara qual dia deseja agendar?\nExemplos: "hoje", "amanhã" ou "25/12"`,

        /**mostra os próximos dias abertos */
        showAvailableDays: (days) => {
            if (!days || days.length === 0)
                return `${emoji.warn} Nenhum dia disponível esta semana. Tente novamente mais tarde.`;
            const formatted = days.map((d, i) =>
                `${i + 1}️⃣ ${d.formatted.charAt(0).toUpperCase() + d.formatted.slice(1)}`
            ).join('\n');
            return `${emoji.calendar} *Escolha um dia disponível:*\n${formatted}`;
        },

        showAvailableSlots: (slots) => {
            if (!slots || slots.length === 0)
                return `${emoji.warn} Poxa, não tenho horários disponíveis para este dia. Escolha outra data.`;
            const formattedSlots = slots.map((slot, i) => {
                const d = new Date(slot);
                return `${i + 1}️⃣ ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
            }).join('\n');
            return `${emoji.check} *Horários disponíveis:*\n${formattedSlots}\n\nEnvie o número do horário desejado.`;
        },

        appointmentSummary: (service, date) => {
            const dateStr = (date instanceof Date && !Number.isNaN(date.getTime()))
                ? date.toLocaleString('pt-BR')
                : String(date);
            return `*Resumo do Agendamento:*\n\n*Serviço:* ${service}\n*Data:* ${dateStr}\n\nConfirmar?\n1️⃣ - Sim\n2️⃣ - Não`;
        },

        appointmentConfirmed: (service, date) => {
            const dateStr = (date instanceof Date && !Number.isNaN(date.getTime()))
                ? date.toLocaleString('pt-BR')
                : String(date);
            return `${emoji.check} Seu agendamento para *${service}* foi confirmado para ${dateStr}. Te esperamos!`;
        },

        appointmentNotFound: `${emoji.warn} Não encontrei nenhum agendamento futuro no seu nome.`,

        listAppointmentsToChange: (appointments) => {
            const list = generateNumberedList(appointments, 'appointment');
            if (list === '(Nenhum agendamento encontrado)') return defaults.appointmentNotFound;
            return `Encontrei estes agendamentos futuros:\n\n${list}\n\nEnvie o número do que deseja alterar.`;
        },

        appointmentChanged: `Ok, o agendamento anterior foi cancelado. Vamos remarcar ${emoji.repeat}`,

        confirmCancellation: (summary, date) =>
            `Encontrei este agendamento:\n\n*${summary}*\n*Data:* ${date}\n\nDeseja cancelar?\n1️⃣ - Sim\n2️⃣ - Não`,

        appointmentCancelled: `${emoji.check} Agendamento cancelado com sucesso!`,

        /**Novas respostas para regras de agenda */
        holidayClosed: `${emoji.cross} O estabelecimento está fechado neste feriado. Escolha outro dia ou aguarde a próxima data disponível.`,
        minAdvanceNotMet: `${emoji.warn} O agendamento precisa ser feito com antecedência mínima. Escolha um horário mais tarde ou outro dia.`,
        sameDayNotAllowed: `${emoji.cross} Este estabelecimento não aceita agendamentos para o mesmo dia. Escolha outro dia.`,

        default: `Não entendi sua mensagem ${emoji.warn}\nDigite *menu* para ver as opções disponíveis.`
    };

    const finalResponses = {};
    for (const key in defaults) {
        const template = clientResponses[key] || defaults[key];
        finalResponses[key] = (...args) => {
            try {
                if (typeof template === 'function') {
                    if (key === 'welcome')
                        return template(args[0], businessName, serviceListString);
                    if (key === 'askForService')
                        return template(serviceListString);
                    return template(...args);
                } else {
                    let responseString = String(template);
                    responseString = responseString
                        .replace('{customerName}', args[0] || 'Cliente')
                        .replace('{name}', args[0] || 'Cliente')
                        .replace('{businessName}', businessName)
                        .replace('{serviceList}', serviceListString)
                        .replace('{service}', args[0] || '');
                    return responseString;
                }
            } catch (e) {
                logger.error(`Erro ao formatar resposta "${key}"`, { error: e.message });
                const fallback = defaults[key];
                return typeof fallback === 'function' ? fallback(...args) : fallback;
            }
        };
    }

    return finalResponses;
}

module.exports = { getResponses, generateNumberedList };
