const FLOW_SCHEMA_VERSION = 1;

export const CHATBOT_STATES = Object.freeze([
  "BOT_PENDING",
  "BOT_ACTIVE",
  "WAITING_FOR_CUSTOMER",
  "READY_FOR_HUMAN",
  "HUMAN_ACTIVE",
  "COMPLETED",
  "CANCELLED",
  "ERROR",
]);

export const CHATBOT_QUESTION_TYPES = Object.freeze([
  "text",
  "buttons",
  "list",
  "number",
  "location",
  "contact",
]);

const QUESTION_TYPE_SET = new Set(CHATBOT_QUESTION_TYPES);
const BRANCH_OPERATORS = new Set(["equals", "not_equals", "contains", "in", "exists"]);
const TERMINAL_STATES = new Set(["READY_FOR_HUMAN", "COMPLETED", "CANCELLED", "ERROR"]);
const DEFAULT_HUMAN_KEYWORDS = ["vendedor", "asesor", "persona", "humano"];
const MAX_QUESTIONS = 100;
const MAX_OPTIONS = 10;
const MAX_BUTTON_OPTIONS = 3;
const MAX_INPUT_LENGTH = 500;
const CONFIRMATION_QUESTION_ID = "chatbot_confirmacion_pedido";

function text(value, max = MAX_INPUT_LENGTH) {
  return String(value ?? "").trim().slice(0, max);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeId(value) {
  const result = text(value, 80);
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(result) ? result : "";
}

function finiteNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function issue(path, code, message) {
  return { path, code, message };
}

function normalizeOption(option, index) {
  const source = plainObject(option) ? option : {};
  const id = normalizeId(source.id) || `option_${index + 1}`;
  return {
    id,
    label: text(source.label, 80),
    value: text(source.value ?? source.id ?? source.label, 120),
    nextQuestionId: normalizeId(source.nextQuestionId) || null,
  };
}

function normalizeValidation(validation) {
  const source = plainObject(validation) ? validation : {};
  const minLength = finiteNumber(source.minLength);
  const maxLength = finiteNumber(source.maxLength);
  const min = finiteNumber(source.min);
  const max = finiteNumber(source.max);
  return {
    ...(minLength === null ? {} : { minLength: Math.max(0, Math.floor(minLength)) }),
    ...(maxLength === null ? {} : { maxLength: Math.max(0, Math.floor(maxLength)) }),
    ...(min === null ? {} : { min }),
    ...(max === null ? {} : { max }),
    ...(source.pattern ? { pattern: text(source.pattern, 160) } : {}),
  };
}

function normalizeBranch(branch) {
  const source = plainObject(branch) ? branch : {};
  const values = Array.isArray(source.values)
    ? source.values.slice(0, 30).map((value) => text(value, 120))
    : [];
  return {
    operator: text(source.operator, 30),
    value: text(source.value, 120),
    values,
    nextQuestionId: normalizeId(source.nextQuestionId) || null,
  };
}

function normalizeQuestion(question, index) {
  const source = plainObject(question) ? question : {};
  return {
    id: normalizeId(source.id) || `question_${index + 1}`,
    key: normalizeId(source.key) || normalizeId(source.id) || `answer_${index + 1}`,
    prompt: text(source.prompt, 1000),
    type: text(source.type, 30).toLowerCase(),
    required: source.required !== false,
    invalidMessage: text(source.invalidMessage, 500) || null,
    options: Array.isArray(source.options)
      ? source.options.slice(0, MAX_OPTIONS + 1).map(normalizeOption)
      : [],
    validation: normalizeValidation(source.validation),
    branches: Array.isArray(source.branches)
      ? source.branches.slice(0, 30).map(normalizeBranch)
      : [],
    nextQuestionId: normalizeId(source.nextQuestionId) || null,
  };
}

export function normalizeFlowDefinition(flow = {}) {
  const source = plainObject(flow) ? flow : {};
  const questions = Array.isArray(source.questions)
    ? source.questions.slice(0, MAX_QUESTIONS + 1).map(normalizeQuestion)
    : [];
  const maxAttempts = Math.max(1, Math.min(10, Math.floor(Number(source.maxAttempts) || 3)));
  const transferSource = plainObject(source.transfer) ? source.transfer : {};
  const humanKeywords = Array.isArray(transferSource.humanKeywords)
    ? transferSource.humanKeywords.map((value) => text(value, 60).toLowerCase()).filter(Boolean).slice(0, 30)
    : DEFAULT_HUMAN_KEYWORDS;

  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    id: normalizeId(source.id) || null,
    name: text(source.name, 160),
    description: text(source.description, 1000),
    welcomeMessage: text(source.welcomeMessage, 1000),
    closingMessage: text(source.closingMessage, 1000),
    invalidMessage: text(source.invalidMessage, 500) || "No pude validar esa respuesta. Intentá nuevamente.",
    maxAttempts,
    startQuestionId: normalizeId(source.startQuestionId) || questions[0]?.id || null,
    confirmation: {
      enabled: source.confirmation?.enabled === true,
      prompt: text(source.confirmation?.prompt, 450) || "Revisá los datos de tu solicitud. ¿Confirmás que son correctos?",
      confirmLabel: text(source.confirmation?.confirmLabel, 20) || "Confirmar pedido",
      editLabel: text(source.confirmation?.editLabel, 20) || "Modificar datos",
    },
    transfer: {
      onComplete: transferSource.onComplete !== false,
      humanKeywords,
      message: text(transferSource.message, 500) || "Gracias. Un vendedor continuará la atención.",
    },
    questions,
  };
}

function hasUnsafePattern(pattern) {
  if (!pattern) return false;
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) return true;
  if (/\\[1-9]|\(\?[=!<]|\(\?:.*[+*].*\)[+*{]/.test(pattern)) return true;
  return /\([^)]*\)[+*{]/.test(pattern);
}

function outgoingIds(question) {
  return [
    question.nextQuestionId,
    ...question.options.map((option) => option.nextQuestionId),
    ...question.branches.map((branch) => branch.nextQuestionId),
  ].filter(Boolean);
}

function graphDiagnostics(flow, questionMap, errors, warnings) {
  const visited = new Set();
  const active = new Set();

  function visit(id, path = []) {
    if (!id || !questionMap.has(id)) return;
    if (active.has(id)) {
      errors.push(issue("questions", "cycle", `El flujo contiene un ciclo: ${[...path, id].join(" -> ")}.`));
      return;
    }
    if (visited.has(id)) return;
    active.add(id);
    for (const nextId of outgoingIds(questionMap.get(id))) visit(nextId, [...path, id]);
    active.delete(id);
    visited.add(id);
  }

  visit(flow.startQuestionId);
  for (const question of flow.questions) {
    if (!visited.has(question.id)) {
      warnings.push(issue(`questions.${question.id}`, "unreachable", "La pregunta no es alcanzable desde el inicio."));
    }
  }
}

export function validateFlowDefinition(input) {
  const flow = normalizeFlowDefinition(input);
  const errors = [];
  const warnings = [];

  if (!plainObject(input)) errors.push(issue("flow", "invalid_type", "El flujo debe ser un objeto."));
  if (flow.confirmation.enabled) {
    for (const field of ["confirmLabel", "editLabel"]) {
      if (flow.confirmation[field].length > 20) errors.push(issue(`confirmation.${field}`, "limit", "El texto del botón no puede superar 20 caracteres."));
    }
  }
  if (!flow.name) errors.push(issue("name", "required", "El nombre del flujo es obligatorio."));
  if (!flow.welcomeMessage) warnings.push(issue("welcomeMessage", "recommended", "Conviene definir un mensaje de bienvenida."));
  if (!flow.questions.length) errors.push(issue("questions", "required", "El flujo debe incluir al menos una pregunta."));
  if (Array.isArray(input?.questions) && input.questions.length > MAX_QUESTIONS) {
    errors.push(issue("questions", "limit", `El flujo no puede superar ${MAX_QUESTIONS} preguntas.`));
  }

  const questionMap = new Map();
  const answerKeys = new Set();
  flow.questions.forEach((question, index) => {
    const path = `questions[${index}]`;
    const rawQuestion = plainObject(input?.questions?.[index]) ? input.questions[index] : {};
    if (rawQuestion.id !== undefined && !normalizeId(rawQuestion.id)) {
      errors.push(issue(`${path}.id`, "invalid", "El identificador de pregunta es inválido."));
    }
    if (rawQuestion.key !== undefined && !normalizeId(rawQuestion.key)) {
      errors.push(issue(`${path}.key`, "invalid", "La clave de respuesta es inválida."));
    }
    if (questionMap.has(question.id)) errors.push(issue(`${path}.id`, "duplicate", "El identificador de pregunta está repetido."));
    questionMap.set(question.id, question);
    if (answerKeys.has(question.key)) errors.push(issue(`${path}.key`, "duplicate", "La clave de respuesta está repetida."));
    answerKeys.add(question.key);
    if (!question.prompt) errors.push(issue(`${path}.prompt`, "required", "La pregunta no puede estar vacía."));
    if (!QUESTION_TYPE_SET.has(question.type)) errors.push(issue(`${path}.type`, "unsupported", "El tipo de respuesta no está soportado."));
    if (["buttons", "list"].includes(question.type)) {
      if (question.options.length < 1) errors.push(issue(`${path}.options`, "required", "Botones y listas requieren opciones."));
      if (question.options.length > MAX_OPTIONS) errors.push(issue(`${path}.options`, "limit", `No se permiten más de ${MAX_OPTIONS} opciones.`));
      if (question.type === "buttons" && question.options.length > MAX_BUTTON_OPTIONS) {
        errors.push(issue(`${path}.options`, "limit", `WhatsApp admite hasta ${MAX_BUTTON_OPTIONS} botones de respuesta.`));
      }
    }
    const optionIds = new Set();
    question.options.forEach((option, optionIndex) => {
      const optionPath = `${path}.options[${optionIndex}]`;
      if (!option.label || !option.value) errors.push(issue(optionPath, "required", "Cada opción necesita etiqueta y valor."));
      if (question.type === "buttons" && option.label.length > 20) {
        errors.push(issue(`${optionPath}.label`, "limit", "La etiqueta de un botón no puede superar 20 caracteres."));
      }
      if (question.type === "list" && option.label.length > 24) {
        errors.push(issue(`${optionPath}.label`, "limit", "La etiqueta de una lista no puede superar 24 caracteres."));
      }
      if (optionIds.has(option.id)) errors.push(issue(`${optionPath}.id`, "duplicate", "El identificador de opción está repetido."));
      optionIds.add(option.id);
    });
    const { minLength, maxLength, min, max, pattern } = question.validation;
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
      errors.push(issue(`${path}.validation`, "range", "minLength no puede superar maxLength."));
    }
    if (min !== undefined && max !== undefined && min > max) {
      errors.push(issue(`${path}.validation`, "range", "min no puede superar max."));
    }
    if (pattern) {
      try {
        new RegExp(pattern, "u");
      } catch {
        errors.push(issue(`${path}.validation.pattern`, "invalid", "La expresión regular no es válida."));
      }
      if (hasUnsafePattern(pattern)) {
        errors.push(issue(`${path}.validation.pattern`, "unsafe", "El patrón debe estar anclado y no puede usar construcciones de riesgo."));
      }
    }
    question.branches.forEach((branch, branchIndex) => {
      if (!BRANCH_OPERATORS.has(branch.operator)) {
        errors.push(issue(`${path}.branches[${branchIndex}].operator`, "unsupported", "El operador de bifurcación no está soportado."));
      }
      if (!branch.nextQuestionId) {
        errors.push(issue(`${path}.branches[${branchIndex}].nextQuestionId`, "required", "La bifurcación necesita un destino."));
      }
      if (branch.operator === "in" && !branch.values.length) {
        errors.push(issue(`${path}.branches[${branchIndex}].values`, "required", "El operador in necesita valores."));
      }
    });
  });

  if (flow.startQuestionId && !questionMap.has(flow.startQuestionId)) {
    errors.push(issue("startQuestionId", "not_found", "La pregunta inicial no existe."));
  }
  flow.questions.forEach((question, index) => {
    for (const nextId of outgoingIds(question)) {
      if (!questionMap.has(nextId)) {
        errors.push(issue(`questions[${index}]`, "target_not_found", `El destino ${nextId} no existe.`));
      }
    }
  });
  if (flow.startQuestionId && questionMap.has(flow.startQuestionId)) {
    graphDiagnostics(flow, questionMap, errors, warnings);
  }

  return { valid: errors.length === 0, errors, warnings, flow };
}

function humanRequested(rawValue, keywords) {
  if (typeof rawValue !== "string") return false;
  const normalized = rawValue.trim().toLocaleLowerCase("es-AR");
  return keywords.some((keyword) => normalized.includes(keyword));
}

function answerFromOption(question, rawValue) {
  const candidate = plainObject(rawValue)
    ? text(rawValue.id ?? rawValue.value ?? rawValue.label, 120)
    : text(rawValue, 120);
  const normalized = candidate.toLocaleLowerCase("es-AR");
  const option = question.options.find((item) =>
    [item.id, item.value, item.label].some((value) => value.toLocaleLowerCase("es-AR") === normalized)
  );
  return option ? { value: option.value, optionId: option.id, nextQuestionId: option.nextQuestionId } : null;
}

function validateAnswer(question, rawValue) {
  const empty = rawValue === null || rawValue === undefined || rawValue === "";
  if (empty && !question.required) return { valid: true, value: null };
  if (empty) return { valid: false, code: "required" };

  if (["buttons", "list"].includes(question.type)) {
    const selected = answerFromOption(question, rawValue);
    return selected ? { valid: true, ...selected } : { valid: false, code: "invalid_option" };
  }

  if (question.type === "number") {
    const value = finiteNumber(typeof rawValue === "string" ? rawValue.replace(",", ".") : rawValue);
    if (value === null) return { valid: false, code: "invalid_number" };
    if (question.validation.min !== undefined && value < question.validation.min) return { valid: false, code: "min" };
    if (question.validation.max !== undefined && value > question.validation.max) return { valid: false, code: "max" };
    return { valid: true, value };
  }

  if (question.type === "location") {
    const latitude = finiteNumber(rawValue?.latitude);
    const longitude = finiteNumber(rawValue?.longitude);
    if (latitude === null || longitude === null || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return { valid: false, code: "invalid_location" };
    }
    return { valid: true, value: { latitude, longitude, name: text(rawValue?.name, 160) || null } };
  }

  if (question.type === "contact") {
    const phone = text(rawValue?.phone ?? rawValue, 40).replace(/[^+\d]/g, "");
    if (!/^\+?\d{8,15}$/.test(phone)) return { valid: false, code: "invalid_contact" };
    return { valid: true, value: { phone, name: text(rawValue?.name, 160) || null } };
  }

  const value = text(rawValue, MAX_INPUT_LENGTH);
  if (!value && question.required) return { valid: false, code: "required" };
  if (question.validation.minLength !== undefined && value.length < question.validation.minLength) return { valid: false, code: "min_length" };
  if (question.validation.maxLength !== undefined && value.length > question.validation.maxLength) return { valid: false, code: "max_length" };
  if (question.validation.pattern && !new RegExp(question.validation.pattern, "u").test(value)) return { valid: false, code: "pattern" };
  return { valid: true, value };
}

function branchMatches(branch, value) {
  const comparable = plainObject(value) ? JSON.stringify(value) : String(value ?? "");
  const expected = branch.value;
  if (branch.operator === "equals") return comparable === expected;
  if (branch.operator === "not_equals") return comparable !== expected;
  if (branch.operator === "contains") return comparable.toLocaleLowerCase("es-AR").includes(expected.toLocaleLowerCase("es-AR"));
  if (branch.operator === "in") return branch.values.includes(comparable);
  if (branch.operator === "exists") return value !== null && value !== undefined && value !== "";
  return false;
}

function nextQuestionId(question, answer) {
  const branch = question.branches.find((candidate) => branchMatches(candidate, answer.value));
  return branch?.nextQuestionId || answer.nextQuestionId || question.nextQuestionId || null;
}

function summaryForConfirmation(state, flow) {
  const labels = new Map(flow.questions.map((item) => [item.key, item.prompt]));
  const rows = state.answerOrder
    .filter((key, index, all) => all.indexOf(key) === index)
    .map((key) => {
      const answer = state.answers[key];
      if (!answer || answer.value === null) return null;
      const raw = answer.value;
      const displayed = typeof raw === "object"
        ? (raw.phone || (Number.isFinite(raw.latitude) && Number.isFinite(raw.longitude) ? "Ubicación compartida" : null))
        : String(raw);
      return displayed ? `${text(labels.get(key), 70)}: ${text(displayed, 100)}` : null;
    }).filter(Boolean);
  // No se muestran precios calculados ni disponibilidad: esos valores requieren fuentes comerciales verificadas.
  return `${flow.confirmation.prompt}${rows.length ? `\n\n${rows.join("\n")}` : ""}`.slice(0, 1000);
}

function requestConfirmation(state, flow) {
  state.status = "WAITING_FOR_CUSTOMER";
  state.currentQuestionId = CONFIRMATION_QUESTION_ID;
  state.messages.push(message("confirmation", summaryForConfirmation(state, flow), CONFIRMATION_QUESTION_ID));
}

function message(kind, body, questionId = null) {
  return { kind, body, ...(questionId ? { questionId } : {}) };
}

function transfer(state, reason, flow) {
  state.status = "READY_FOR_HUMAN";
  state.transferReason = reason;
  state.messages.push(message("transfer", flow.transfer.message));
}

export function createSimulation(flow) {
  const questionMap = new Map(flow.questions.map((question) => [question.id, question]));
  const state = {
    status: "BOT_ACTIVE",
    currentQuestionId: flow.startQuestionId,
    attemptsForCurrentQuestion: 0,
    answers: {},
    answerOrder: [],
    transferReason: null,
    messages: [],
  };
  if (flow.welcomeMessage) state.messages.push(message("welcome", flow.welcomeMessage));
  const first = questionMap.get(flow.startQuestionId);
  if (first) {
    state.status = "WAITING_FOR_CUSTOMER";
    state.messages.push(message("question", first.prompt, first.id));
  } else {
    state.status = "ERROR";
    state.transferReason = "INVALID_FLOW";
  }
  return state;
}

export function advanceSimulation(flow, previousState, rawValue) {
  const state = structuredClone(previousState);
  if (TERMINAL_STATES.has(state.status)) return state;
  const questionMap = new Map(flow.questions.map((question) => [question.id, question]));
  if (flow.confirmation.enabled && state.currentQuestionId === CONFIRMATION_QUESTION_ID) {
    if (humanRequested(rawValue, flow.transfer.humanKeywords)) {
      transfer(state, "CUSTOMER_REQUESTED_HUMAN", flow);
      return state;
    }
    const choice = plainObject(rawValue) ? text(rawValue.id ?? rawValue.value ?? rawValue.label, 120) : text(rawValue, 120);
    if (["confirmar", "confirmar_pedido", flow.confirmation.confirmLabel].some((value) => choice.toLowerCase() === value.toLowerCase())) {
      state.orderConfirmed = true;
      if (flow.closingMessage) state.messages.push(message("closing", flow.closingMessage));
      transfer(state, "ORDER_CONFIRMED", flow);
      return state;
    }
    if (["modificar", "modificar_datos", flow.confirmation.editLabel].some((value) => choice.toLowerCase() === value.toLowerCase())) {
      // Volver a reunir los datos sin crear ni confirmar una solicitud.
      state.answers = {};
      state.answerOrder = [];
      state.attemptsForCurrentQuestion = 0;
      state.currentQuestionId = flow.startQuestionId;
      state.orderConfirmed = false;
      state.status = "WAITING_FOR_CUSTOMER";
      const firstQuestion = questionMap.get(flow.startQuestionId);
      if (firstQuestion) state.messages.push(message("question", firstQuestion.prompt, firstQuestion.id));
      return state;
    }
    state.attemptsForCurrentQuestion += 1;
    if (state.attemptsForCurrentQuestion >= flow.maxAttempts) transfer(state, "MAX_ATTEMPTS", flow);
    else state.messages.push(message("confirmation", summaryForConfirmation(state, flow), CONFIRMATION_QUESTION_ID));
    return state;
  }
  const question = questionMap.get(state.currentQuestionId);
  if (!question) {
    state.status = "ERROR";
    state.transferReason = "QUESTION_NOT_FOUND";
    return state;
  }

  if (humanRequested(rawValue, flow.transfer.humanKeywords)) {
    transfer(state, "CUSTOMER_REQUESTED_HUMAN", flow);
    return state;
  }

  const answer = validateAnswer(question, rawValue);
  if (!answer.valid) {
    state.attemptsForCurrentQuestion += 1;
    state.messages.push(message("invalid", question.invalidMessage || flow.invalidMessage, question.id));
    if (state.attemptsForCurrentQuestion >= flow.maxAttempts) {
      transfer(state, "MAX_ATTEMPTS", flow);
    } else {
      state.messages.push(message("question", question.prompt, question.id));
    }
    return state;
  }

  state.answers[question.key] = {
    questionId: question.id,
    type: question.type,
    value: answer.value,
    ...(answer.optionId ? { optionId: answer.optionId } : {}),
  };
  state.answerOrder.push(question.key);
  state.attemptsForCurrentQuestion = 0;
  const nextId = nextQuestionId(question, answer);
  state.currentQuestionId = nextId;
  if (nextId) {
    const nextQuestion = questionMap.get(nextId);
    if (!nextQuestion) {
      state.status = "ERROR";
      state.transferReason = "QUESTION_NOT_FOUND";
      return state;
    }
    state.status = "WAITING_FOR_CUSTOMER";
    state.messages.push(message("question", nextQuestion.prompt, nextQuestion.id));
    return state;
  }

  if (flow.confirmation.enabled) {
    requestConfirmation(state, flow);
    return state;
  }
  if (flow.closingMessage) state.messages.push(message("closing", flow.closingMessage));
  if (flow.transfer.onComplete) transfer(state, "FLOW_COMPLETED", flow);
  else state.status = "COMPLETED";
  return state;
}

export function simulateFlow(input, responses = []) {
  const validation = validateFlowDefinition(input);
  if (!validation.valid) {
    return { ok: false, validation, state: null };
  }
  if (!Array.isArray(responses) || responses.length > 200) {
    return {
      ok: false,
      validation: {
        ...validation,
        valid: false,
        errors: [...validation.errors, issue("responses", "limit", "La simulación admite hasta 200 respuestas.")],
      },
      state: null,
    };
  }
  let state = createSimulation(validation.flow);
  for (const response of responses) {
    if (TERMINAL_STATES.has(state.status)) break;
    state = advanceSimulation(validation.flow, state, response);
  }
  return { ok: true, validation, state };
}

export const chatbotFlowInternals = Object.freeze({
  branchMatches,
  validateAnswer,
  humanRequested,
  nextQuestionId,
});
