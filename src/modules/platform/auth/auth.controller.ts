import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import {
  attachRefreshCookie,
  AuthRequestLike,
  clearRefreshCookie,
  CookieResponse,
  readRefreshCookie,
} from './auth-context';
import { AuthService, AuthSessionResult } from './auth.service';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password-recovery.dto';
import { RegisterDto } from './dto/register.dto';
import { LegacySignInDto, SignInDto } from './dto/sign-in.dto';
import { ResendVerificationDto, VerifyRegistrationDto } from './dto/verify-registration.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * The refresh token only ever leaves the API as an HttpOnly cookie scoped to
   * the auth routes. The response body carries the short-lived access token.
   */
  private respond(res: CookieResponse, result: AuthSessionResult) {
    attachRefreshCookie(res, result.refreshToken, result.refreshTokenExpiresAt);
    return { data: result.payload };
  }

  @Post('register')
  @HttpCode(201)
  async register(@Body() dto: RegisterDto, @Req() request: AuthRequestLike) {
    return { data: await this.authService.register(dto, request) };
  }

  @Post('register/verify')
  @HttpCode(200)
  async verifyRegistration(
    @Body() dto: VerifyRegistrationDto,
    @Req() request: AuthRequestLike,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    return this.respond(res, await this.authService.verifyRegistration(dto, request));
  }

  @Post('register/resend')
  @HttpCode(200)
  async resendVerification(
    @Body() dto: ResendVerificationDto,
    @Req() request: AuthRequestLike,
  ) {
    return { data: await this.authService.resendVerification(dto, request) };
  }

  @Post('sign-in')
  @HttpCode(200)
  async signIn(
    @Body() dto: SignInDto,
    @Req() request: AuthRequestLike,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    return this.respond(res, await this.authService.signIn(dto, request));
  }

  /** Backwards compatible alias for clients written against the first API draft. */
  @Post('login')
  @HttpCode(200)
  async legacySignIn(
    @Body() dto: LegacySignInDto,
    @Req() request: AuthRequestLike,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    return this.respond(res, await this.authService.signIn(dto, request));
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() request: AuthRequestLike,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    return this.respond(res, await this.authService.refresh(request, readRefreshCookie(request)));
  }

  @Post('sign-out')
  @HttpCode(200)
  async signOut(
    @Req() request: AuthRequestLike,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    const result = await this.authService.signOut(request, readRefreshCookie(request));
    clearRefreshCookie(res);
    return { data: result };
  }

  /** Backwards compatible alias for clients written against the first API draft. */
  @Post('logout')
  @HttpCode(200)
  async legacyLogout(
    @Req() request: AuthRequestLike,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    const result = await this.authService.signOut(request, readRefreshCookie(request));
    clearRefreshCookie(res);
    return { data: result };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(
    @CurrentUser('sub') userId: string,
    @CurrentUser('organisationId') organisationId: string,
  ) {
    return { data: await this.authService.getProfile(userId, organisationId) };
  }

  @Post('password/forgot')
  @HttpCode(200)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() request: AuthRequestLike) {
    return { data: await this.authService.forgotPassword(dto, request) };
  }

  @Post('password/reset')
  @HttpCode(200)
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() request: AuthRequestLike) {
    return { data: await this.authService.resetPassword(dto, request) };
  }
}
