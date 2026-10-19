import { createHmac } from 'node:crypto';
import { verifyMercadoPagoSignature } from './mercadopago-signature.js';

const SECRET = 'app-webhook-secret';

function sign(manifest: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(manifest).digest('hex');
}

describe('verifyMercadoPagoSignature', () => {
  const ts = '1704908010';
  const requestId = 'bb56a2f1-6aae-46ac-982e-9dcd3581d08e';
  const dataId = '123456789';
  const header = `ts=${ts},v1=${sign(`id:${dataId};request-id:${requestId};ts:${ts};`)}`;

  it('accepts a notification signed with the application secret', () => {
    expect(
      verifyMercadoPagoSignature({
        signatureHeader: header,
        requestId,
        dataId,
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it('tolerates spaces around the header parts', () => {
    const spaced = header.replace(',', ' , ');
    expect(
      verifyMercadoPagoSignature({
        signatureHeader: spaced,
        requestId,
        dataId,
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it('refuses a notification about another resource', () => {
    expect(
      verifyMercadoPagoSignature({
        signatureHeader: header,
        requestId,
        dataId: '987654321',
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it('refuses a signature made with another secret', () => {
    expect(
      verifyMercadoPagoSignature({
        signatureHeader: header,
        requestId,
        dataId,
        secret: 'someone-else',
      }),
    ).toBe(false);
  });

  it('lowercases an alphanumeric data.id before signing', () => {
    const orderId = 'ORD01JQ4S4KY8HWQ6NA5PXB65B3D3';
    const signed = `ts=${ts},v1=${sign(`id:${orderId.toLowerCase()};request-id:${requestId};ts:${ts};`)}`;
    expect(
      verifyMercadoPagoSignature({
        signatureHeader: signed,
        requestId,
        dataId: orderId,
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it('leaves out the parts that did not arrive', () => {
    const signed = `ts=${ts},v1=${sign(`ts:${ts};`)}`;
    expect(
      verifyMercadoPagoSignature({ signatureHeader: signed, secret: SECRET }),
    ).toBe(true);
  });

  it('fails closed on a missing header, secret, ts or v1', () => {
    const base = { requestId, dataId, secret: SECRET };
    expect(verifyMercadoPagoSignature({ ...base, signatureHeader: '' })).toBe(
      false,
    );
    expect(
      verifyMercadoPagoSignature({
        ...base,
        signatureHeader: header,
        secret: undefined,
      }),
    ).toBe(false);
    expect(
      verifyMercadoPagoSignature({ ...base, signatureHeader: `v1=abc` }),
    ).toBe(false);
    expect(
      verifyMercadoPagoSignature({ ...base, signatureHeader: `ts=${ts}` }),
    ).toBe(false);
    expect(
      verifyMercadoPagoSignature({
        ...base,
        signatureHeader: `ts=${ts},v1=not-hex`,
      }),
    ).toBe(false);
  });
});
