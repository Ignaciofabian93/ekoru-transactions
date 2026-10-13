import { MASK, haveTraded, maskContactDetails } from './contact-masking.js';
import { PrismaService } from '../prisma/prisma.service.js';

describe('maskContactDetails (TRX-19)', () => {
  it.each([
    ['escríbeme a ana.rojas@gmail.com', `escríbeme a ${MASK}`],
    ['mi cel es +56 9 8765 4321', `mi cel es ${MASK}`],
    ['llámame al 987654321 mañana', `llámame al ${MASK} mañana`],
    ['al (9) 8765-4321', `al ${MASK}`],
    ['por wsp: https://wa.me/56987654321', `por wsp: ${MASK}`],
    ['o wa.me/56987654321', `o ${MASK}`],
    ['telegram t.me/anarojas', `telegram ${MASK}`],
  ])('hides %j', (text, expected) => {
    expect(maskContactDetails(text)).toEqual({ body: expected, masked: true });
  });

  it.each([
    '¿Sigue disponible? Te ofrezco $25.000',
    'Lo vendo en 1.500.000 con envío',
    'Medidas 120 x 60 x 75 cm, año 2021',
    'Nos vemos el 12/10 a las 18:30',
  ])('leaves %j alone', (text) => {
    expect(maskContactDetails(text)).toEqual({ body: text, masked: false });
  });
});

describe('haveTraded', () => {
  it('asks the database once, for both directions', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ traded: true }]),
    };

    await expect(
      haveTraded(prisma as unknown as PrismaService, 'buyer', 'seller'),
    ).resolves.toBe(true);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('is false without a row', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };

    await expect(
      haveTraded(prisma as unknown as PrismaService, 'a', 'b'),
    ).resolves.toBe(false);
  });
});
