import { ApiProperty } from '@nestjs/swagger';

export class AccessToken {
  @ApiProperty({
    description: 'Send as `Authorization: Bearer <access_token>`',
  })
  access_token: string;
}
