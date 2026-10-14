import { MigrationInterface, QueryRunner } from 'typeorm';

export class AlignSalonTemplateWithBookingWidgetPrd1786442000000 implements MigrationInterface {
  name = 'AlignSalonTemplateWithBookingWidgetPrd1786442000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "industry_templates"
       SET "config" = "config" || $1::jsonb
       WHERE "id" = 'salon'`,
      [
        {
          displayName: 'Beauty Salon',
          hasResourceAssignment: true,
          steps: [
            {
              field: 'serviceId',
              prompt:
                "I'd be happy to help you book an appointment! Which service would you like?",
              uiType: 'service_chips',
            },
            {
              field: 'resourceId',
              prompt: 'Do you have a preferred stylist?',
              uiType: 'staff_chips',
            },
            {
              field: 'date',
              prompt: 'What date would you like to come in?',
              uiType: 'date_chips',
            },
            {
              field: 'timeSlot',
              prompt: 'Please select an available time.',
              uiType: 'slot_picker',
            },
            {
              field: 'customerName',
              prompt: "What's your name?",
              uiType: 'text_input',
            },
            {
              field: 'phone',
              prompt: 'And your phone number?',
              uiType: 'text_input',
            },
            {
              field: 'customerEmail',
              prompt:
                'Would you like to receive a confirmation email? You can type your email or skip.',
              uiType: 'text_input_optional',
            },
          ],
          confirmationDisplay: ['service', 'staff', 'datetime'],
        },
      ],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "industry_templates"
       SET "config" = "config" || $1::jsonb
       WHERE "id" = 'salon'`,
      [
        {
          displayName: 'Beauty Salon',
          hasResourceAssignment: true,
          steps: [
            {
              field: 'serviceId',
              prompt: 'Which service would you like?',
              uiType: 'service_chips',
            },
            {
              field: 'resourceId',
              prompt: 'Do you have a preferred stylist?',
              uiType: 'staff_chips',
            },
            {
              field: 'startAt',
              prompt: 'Please select an available time.',
              uiType: 'slot_picker',
            },
            {
              field: 'customerName',
              prompt: 'May I have your name?',
              uiType: 'text_input',
            },
            {
              field: 'phone',
              prompt: 'What is your phone number?',
              uiType: 'text_input',
            },
          ],
          confirmationDisplay: ['service', 'staff', 'datetime'],
        },
      ],
    );
  }
}
