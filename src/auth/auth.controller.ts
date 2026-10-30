import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginEmailDto, SelectWorkspaceDto } from './dto/login-email.dto';
import { SlugAvailableQueryDto } from './dto/slug-available.dto';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { CurrentUser } from './current-user.decorator';
import { AccessToken } from './entities/access-token.entity';
import { SignupResponse } from './entities/signup-response.entity';
import {
  LoginEmailResponse,
  SelectWorkspaceResponse,
  SlugAvailability,
} from './entities/workspace-login.entities';
import { Roles } from './roles';
import type { AuthUser } from './roles';
import { RolesGuard } from './roles.guard';
import { SessionAuthGuard } from './session-auth.guard';
import { SlugAvailabilityService } from './slug-availability.service';
import { WorkspaceLoginService } from './workspace-login.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly workspaceLogin: WorkspaceLoginService,
    private readonly slugAvailability: SlugAvailabilityService,
  ) {}

  @Post('login')
  @ApiOperation({
    summary: 'Staff login with tenant slug, email and password',
    description:
      'The workspace-specific login. A slug the workspace used in the last 30 days still works (J3). Throttled: 429 with Retry-After after 5 wrong passwords for one email from one address in 15 minutes, 30 wrong passwords from one address, or 60 requests a minute from one address.',
  })
  @ApiCreatedResponse({ type: AccessToken })
  login(@Body() dto: LoginDto, @Ip() ip: string) {
    return this.authService.login(dto, ip);
  }

  @Post('login-email')
  @ApiOperation({
    summary:
      'Step one of the email-first login: email and password, no slug (J2)',
    description:
      'Checks the password against every workspace where this email exists and answers with the workspaces it opens (workspaces), a selectionToken for step two, and how many other workspaces use a different password (unmatchedCount). When exactly one workspace is available the answer also has the access_token and workspace, so the picker can be skipped. A wrong password and an unknown email are the same 401 INVALID_CREDENTIALS in the same time. Throttled like /auth/login.',
  })
  @ApiCreatedResponse({ type: LoginEmailResponse })
  loginByEmail(@Body() dto: LoginEmailDto, @Ip() ip: string) {
    return this.workspaceLogin.loginByEmail(dto, ip);
  }

  @Post('select-workspace')
  @ApiOperation({
    summary: 'Step two: open one of the workspaces from step one (J2)',
    description:
      'Needs the selectionToken (valid for 10 minutes; it can be used again to switch to another listed workspace) and the tenantId of one of its workspaces. Answers like the slug login, plus the workspace. Errors: 401 SELECTION_TOKEN_INVALID (expired, forged, or the user logged out or changed the password since), 403 WORKSPACE_NOT_SELECTABLE (not one of the listed workspaces), and the usual 403 ACCOUNT_DISABLED / TENANT_SUSPENDED / TENANT_CLOSED.',
  })
  @ApiCreatedResponse({ type: SelectWorkspaceResponse })
  selectWorkspace(@Body() dto: SelectWorkspaceDto) {
    return this.workspaceLogin.selectWorkspace(dto);
  }

  @Get('slug-available')
  @ApiOperation({
    summary: 'Is this workspace address free? (public)',
    description:
      "Used while typing at signup and by the owner's rename (J3). Answers only yes or no and up to three free alternatives; a slug an earlier workspace gave up less than 90 days ago counts as taken. Limited to 30 checks a minute per address (429).",
  })
  @ApiOkResponse({ type: SlugAvailability })
  slugAvailable(@Query() query: SlugAvailableQueryDto, @Ip() ip: string) {
    return this.slugAvailability.check(query.slug, ip);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles('owner', 'admin', 'agent')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Log out of every session of this user',
    description:
      'Sets the user\'s "tokens valid after" instant to now: every token issued before it, on every device, stops working ("log out everywhere"; one timestamp per user, so a single device cannot be logged out on its own). A login afterwards works at once. Works even when the workspace is suspended. Clear the cookie in the frontend as well. Widget tokens are not affected.',
  })
  @ApiNoContentResponse()
  async logout(@CurrentUser() actor: AuthUser) {
    await this.authService.logout(actor);
  }

  @Post('signup')
  @ApiOperation({ summary: 'Create a tenant and its owner account' })
  @ApiCreatedResponse({ type: SignupResponse })
  signup(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }
}
