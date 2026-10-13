import { PrismaService } from '../prisma/prisma.service.js';

/** What a masked contact detail is replaced with. Language-neutral on purpose. */
export const MASK = '[•••]';

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;

/** WhatsApp and Telegram links, with or without the scheme. */
const MESSAGING_LINK =
  /\b(?:https?:\/\/)?(?:www\.)?(?:wa\.me|(?:api|chat|web)\.whatsapp\.com|whatsapp\.com|t\.me|telegram\.me)\/\S*/gi;

/** A run of digits with the separators people put in phone numbers. */
const DIGIT_RUN = /\+?\(?\d[\d\s().-]{5,}\d/g;

/**
 * Eight digits or more is a phone number. Chilean mobiles have nine (eleven
 * with +56); prices in CLP stay below eight digits until ten million.
 */
const MIN_PHONE_DIGITS = 8;

/**
 * Replaces emails, phone numbers and messaging links with {@link MASK}
 * (TRX-19). Returns the text and whether anything changed.
 */
export function maskContactDetails(text: string): {
  body: string;
  masked: boolean;
} {
  let masked = false;
  const hide = () => {
    masked = true;
    return MASK;
  };
  const body = text
    .replace(MESSAGING_LINK, hide)
    .replace(EMAIL, hide)
    .replace(DIGIT_RUN, (run) =>
      run.replace(/\D/g, '').length >= MIN_PHONE_DIGITS ? hide() : run,
    );
  return { body, masked };
}

/**
 * Whether two sellers have traded on EKORU: an accepted, completed or disputed
 * deal, a paid or refunded order, or a booking, in either direction. The same
 * rule ekoru-users applies to contact details on profiles (USR-10). A proposed
 * deal is not enough, so nobody unlocks contact details by proposing one.
 */
export async function haveTraded(
  prisma: PrismaService,
  a: string,
  b: string,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ traded: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "P2PDeal"
       WHERE status IN ('ACCEPTED', 'COMPLETED', 'DISPUTED')
         AND (("buyerId" = ${a} AND "sellerId" = ${b})
           OR ("buyerId" = ${b} AND "sellerId" = ${a}))
      UNION ALL
      SELECT 1 FROM "Order"
       WHERE status IN ('PAID', 'REFUNDED')
         AND (("buyerId" = ${a} AND "sellerId" = ${b})
           OR ("buyerId" = ${b} AND "sellerId" = ${a}))
      UNION ALL
      SELECT 1 FROM "ServiceBooking"
       WHERE ("clientId" = ${a} AND "providerId" = ${b})
          OR ("clientId" = ${b} AND "providerId" = ${a})
    ) AS "traded"
  `;
  return rows[0]?.traded === true;
}
