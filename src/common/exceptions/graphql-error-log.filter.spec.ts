import { ArgumentsHost, Logger } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { GraphQLErrorLogFilter } from './graphql-error-log.filter.js';

function host(context: Record<string, unknown>): ArgumentsHost {
  const info = { parentType: { name: 'Query' }, fieldName: 'anyField' };
  return {
    getArgs: () => [{}, {}, context, info],
    getType: () => 'graphql',
  } as unknown as ArgumentsHost;
}

const raised = (message: string, code: string) =>
  new GraphQLError(message, { extensions: { code } });

describe('GraphQLErrorLogFilter', () => {
  const filter = new GraphQLErrorLogFilter();
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('logs an expected error as one warning line and hands it back', () => {
    const missing = raised("Slug 'no-existe' no encontrado", 'NOT_FOUND');

    expect(filter.catch(missing, host({}))).toBe(missing);
    expect(warn).toHaveBeenCalledWith(
      `NOT_FOUND Query.anyField: "Slug 'no-existe' no encontrado" | no access token received (the gateway log says why)`,
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('names an internal call without printing its secret', () => {
    filter.catch(
      raised('Debe iniciar sesión', 'UNAUTHENTICATED'),
      host({ req: { headers: { 'x-internal-secret': 's3cret' } } }),
    );
    const [line] = warn.mock.calls[0] as [string];
    expect(line).toContain('| internal call');
    expect(line).not.toContain('s3cret');
  });

  it('logs internal errors as errors, with the caller and the stack', () => {
    const failed = raised('Error al obtener', 'INTERNAL_SERVER_ERROR');

    filter.catch(failed, host({ sellerId: 'seller-1' }));
    expect(error).toHaveBeenCalledWith(
      'INTERNAL_SERVER_ERROR Query.anyField: "Error al obtener" | seller seller-1',
      failed.stack,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
