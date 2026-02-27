import { Kind } from 'graphql';
import { Scalar, CustomScalar } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';

@Scalar('DateTime')
export class DateTimeScalar implements CustomScalar<string, Date | null> {
  description = 'Date custom scalar type';

  parseValue(value: string): Date {
    return new Date(value);
  }

  serialize(value: Date): string {
    return value instanceof Date ? value.toISOString() : value;
  }

  parseLiteral(ast: any): Date | null {
    if (ast.kind === Kind.STRING) {
      return new Date(ast.value);
    }
    return null;
  }
}

@Scalar('JSON')
export class JSONScalar implements CustomScalar<any, any> {
  description = 'JSON custom scalar type';

  parseValue(value: any): any {
    return value;
  }

  serialize(value: any): any {
    return value;
  }

  parseLiteral(ast: any): any {
    if (ast.kind === Kind.OBJECT) {
      return JSON.parse(JSON.stringify(ast.value));
    }
    return null;
  }
}

export { GraphQLJSON };
