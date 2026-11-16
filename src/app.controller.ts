import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  getHealth() {
    return this.appService.getHealth();
  }

  /** Verifies the database too, and answers 503 when it is unreachable. */
  @Get('health/ready')
  getReadiness() {
    return this.appService.getReadiness();
  }
}
