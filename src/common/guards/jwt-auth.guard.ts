import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request?.headers?.authorization;
    const [type, token] = (header ?? '').split(' ');
    if (type !== 'Bearer' || !token) {
      throw new UnauthorizedException('Missing bearer token');
    }
    try {
      const secret = process.env.JWT_SECRET ?? 'change-me-in-production';
      request.user = jwt.verify(token, secret);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    return true;
  }
}
