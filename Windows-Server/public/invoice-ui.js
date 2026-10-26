// Shared invoice request semantics for standalone billing and embedded accounts.
// Capture the reviewed record and retain an exact retry's key until acknowledged.
export function createRequestAttempts() {
  const attempts = new Map();
  return {
    payload(action, path, payload) {
      const fingerprint = JSON.stringify({path, payload});
      let attempt = attempts.get(action);
      if (!attempt || attempt.fingerprint !== fingerprint) {
        attempt = {fingerprint, key:globalThis.crypto?.randomUUID?.() || `ot-${Date.now()}-${Math.random().toString(36).slice(2)}`};
        attempts.set(action, attempt);
      }
      return {...payload, idempotencyKey:attempt.key};
    },
    clear(action) { attempts.delete(action); }
  };
}

export function repairInvoiceDetails(record, invoices, {email = '', sendEmail = false} = {}) {
  if (!Number.isSafeInteger(Number(record?.revision))) throw Error('Refresh this work order before issuing an invoice.');
  const latest = [...invoices].sort((a, b) => Number(b.id) - Number(a.id))[0];
  return {email, sendEmail:sendEmail === true, expectedRevision:Number(record.revision),
    documentKind:latest ? 'revised_invoice' : 'invoice', ...(latest ? {supersedesInvoiceId:Number(latest.id)} : {})};
}
