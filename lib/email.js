// lib/email.js
import { Resend } from "resend";

export async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM; // ej: 'CRM <notificaciones@tudominio.com>' o 'onboarding@resend.dev'
  if (!apiKey || !from) {
    console.warn("[email] RESEND no configurado; skip");
    return { skipped: true };
  }
  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({ from, to, subject, html });
  if (error) throw error;
  return { ok: true };
}

