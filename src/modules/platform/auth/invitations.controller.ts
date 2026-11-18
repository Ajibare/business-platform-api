import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { CurrentActor } from '../../../common/decorators/current-actor.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import type { RequestActor } from '../../platform/branches/branch-access.service';
import {
  attachRefreshCookie,
  AuthRequestLike,
  CookieResponse,
} from './auth-context';
import { AcceptInvitationDto, CreateInvitationDto } from './dto/invitation.dto';
import { InvitationsService } from './invitations.service';

@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  @HttpCode(201)
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('staff:manage')
  async create(@CurrentActor() actor: RequestActor, @Body() dto: CreateInvitationDto) {
    return this.invitations.create(this.contextOf(actor), dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('staff:read')
  async list(@CurrentActor() actor: RequestActor) {
    return this.invitations.list(this.contextOf(actor));
  }

  /** Sends a fresh link for a pending invitation and retires the old one. */
  @Post(':id/resend')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('staff:manage')
  async resend(@CurrentActor() actor: RequestActor, @Param('id') id: string) {
    return this.invitations.resend(this.contextOf(actor), id);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('staff:manage')
  async revoke(@CurrentActor() actor: RequestActor, @Param('id') id: string) {
    return this.invitations.revoke(this.contextOf(actor), id);
  }

  /** Public: the invite page renders the workspace name and role before sign-in. */
  @Get(':token')
  async preview(@Param('token') token: string, @Req() request: AuthRequestLike) {
    return this.invitations.preview(token, request);
  }

  /** Public: used when the invited person does not have an account yet. */
  @Post(':token/accept')
  @HttpCode(200)
  async acceptNewAccount(
    @Param('token') token: string,
    @Body() dto: AcceptInvitationDto,
    @Req() request: AuthRequestLike,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    const result = await this.invitations.acceptNewAccount(token, dto, request);
    attachRefreshCookie(res, result.refreshToken, result.refreshTokenExpiresAt);
    return { data: result.payload };
  }

  /** Used when the invited person already has an account and is signed in. */
  @Post(':token/accept-existing')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async acceptExisting(
    @Param('token') token: string,
    @CurrentUser('sub') userId: string,
    @Req() request: AuthRequestLike,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    const result = await this.invitations.acceptExisting(userId, token, request);
    attachRefreshCookie(res, result.refreshToken, result.refreshTokenExpiresAt);
    return { data: result.payload };
  }

  /** The service authorises by permission, so it receives the resolved actor. */
  private contextOf(actor: RequestActor) {
    return {
      userId: actor.userId,
      organisationId: actor.organizationId,
      role: actor.role,
      permissions: actor.permissions,
    };
  }
}
