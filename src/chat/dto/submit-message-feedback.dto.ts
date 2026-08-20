import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { FeedbackRating } from '../entities/chat-message.entity';

export class SubmitMessageFeedbackDto {
  @ApiProperty({
    enum: FeedbackRating,
    description:
      'Visitor feedback rating for AI bot response (HELPFUL or UNHELPFUL)',
    example: FeedbackRating.HELPFUL,
  })
  @IsEnum(FeedbackRating)
  rating: FeedbackRating;
}

export class MessageFeedbackResponseDto {
  @ApiProperty({
    description: 'Message UUID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id: string;

  @ApiProperty({
    enum: FeedbackRating,
    description: 'Recorded feedback rating',
    example: FeedbackRating.HELPFUL,
  })
  feedbackRating: FeedbackRating;
}
