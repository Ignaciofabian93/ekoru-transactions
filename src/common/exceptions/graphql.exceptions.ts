import { GraphQLError } from 'graphql';

export class NotFoundError extends GraphQLError {
  constructor(message: string) {
    super(message, {
      extensions: {
        code: 'NOT_FOUND',
      },
    });
  }
}

export class BadRequestError extends GraphQLError {
  constructor(message: string) {
    super(message, {
      extensions: {
        code: 'BAD_REQUEST',
      },
    });
  }
}

export class UnauthorizedError extends GraphQLError {
  constructor(message: string = 'No autorizado') {
    super(message, {
      extensions: {
        code: 'UNAUTHORIZED',
      },
    });
  }
}

export class ForbiddenError extends GraphQLError {
  constructor(message: string = 'Acceso denegado') {
    super(message, {
      extensions: {
        code: 'FORBIDDEN',
      },
    });
  }
}

export class InternalServerError extends GraphQLError {
  constructor(message: string = 'Error interno del servidor') {
    super(message, {
      extensions: {
        code: 'INTERNAL_SERVER_ERROR',
      },
    });
  }
}
