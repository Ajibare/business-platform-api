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
import { Role } from '@prisma/client';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
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
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'MANAGER')
  async create(
    @Body() dto: CreateInvitationDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('organisationId') organisationId: string,
  ) {
    const role = await this.roleOf(userId, organisationId);
    return this.invitations.create({ userId, organisationId, role }, dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'MANAGER')
  async list(
    @CurrentUser('sub') userId: string,
    @CurrentUser('organisationId') organisationId: string,
  ) {
    const role = await this.roleOf(userId, organisationId);
    return this.invitations.list({ userId, organisationId, role });
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'MANAGER')
  async revoke(
    @Param('id') id: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('organisationId') organisationId: string,
  ) {
    const role = await this.roleOf(userId, organisationId);
    return this.invitations.revoke({ userId, organisationId, role }, id);
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

  /**
   * The guard already read the membership, but the service needs the role to
   * apply the "managers cannot invite managers" rule, so it is read explicitly.
   */
  private async roleOf(userId: string, organisationId: string): Promise<Role> {
    return this.invitations.roleOf(userId, organisationId);
  }
}
