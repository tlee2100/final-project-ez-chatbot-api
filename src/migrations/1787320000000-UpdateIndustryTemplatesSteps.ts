import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateIndustryTemplatesSteps1787320000000 implements MigrationInterface {
  name = 'UpdateIndustryTemplatesSteps1787320000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const salonConfig = {
      displayName: 'Beauty Salon',
      hasResourceAssignment: true,
      confirmationDisplay: ['service', 'staff', 'datetime'],
      steps: [
        {
          field: 'serviceId',
          prompt: 'Which service would you like?',
          uiType: 'service_chips',
        },
        {
          field: 'resourceId',
          prompt: 'Do you have a preferred stylist or staff member?',
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
    };

    const generalConfig = {
      displayName: 'General Booking',
      hasResourceAssignment: true,
      confirmationDisplay: ['service', 'resource', 'datetime'],
      steps: [
        {
          field: 'serviceId',
          prompt: 'Which service or facility would you like to book?',
          uiType: 'service_chips',
        },
        {
          field: 'resourceId',
          prompt: 'Which staff member, court, or facility would you prefer?',
          uiType: 'staff_chips',
        },
        {
          field: 'date',
          prompt: 'What date would you like to book?',
          uiType: 'date_chips',
        },
        {
          field: 'timeSlot',
          prompt: 'Please select an available time slot.',
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
        {
          field: 'customerEmail',
          prompt: 'Would you like to receive a confirmation email?',
          uiType: 'text_input_optional',
        },
        {
          field: 'notes',
          prompt: 'Any additional notes or requests?',
          uiType: 'text_input_optional',
        },
      ],
    };

    await queryRunner.query(
      `UPDATE "industry_templates" SET "config" = $1 WHERE "id" = 'salon'`,
      [salonConfig],
    );

    await queryRunner.query(
      `UPDATE "industry_templates" SET "config" = $1 WHERE "id" = 'general'`,
      [generalConfig],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const defaultGeneral = {
      displayName: 'General Booking',
      hasResourceAssignment: false,
      steps: [
        {
          field: 'serviceName',
          prompt: 'What are you booking for?',
          uiType: 'text_input',
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
        {
          field: 'notes',
          prompt: 'Any additional notes?',
          uiType: 'text_input',
        },
      ],
      confirmationDisplay: ['serviceName', 'datetime'],
    };

    await queryRunner.query(
      `UPDATE "industry_templates" SET "config" = $1 WHERE "id" = 'general'`,
      [defaultGeneral],
    );
  }
}
