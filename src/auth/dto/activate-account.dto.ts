import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MinLength } from 'class-validator';

export class ActivateAccountDto {
  @ApiProperty({ description: 'Single-use activation token' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ minLength: 8, example: 'NewPassword123!' })
  @IsString()
  @MinLength(8)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/, {
    message: 'Password must contain lowercase, uppercase, and a number',
  })
  newPassword: string;

  @ApiProperty({ minLength: 8, example: 'NewPassword123!' })
  @IsString()
  @IsNotEmpty()
  confirmNewPassword: string;
}
