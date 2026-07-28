import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class ComfirmTwoFaDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 6)
  code: string;
}
