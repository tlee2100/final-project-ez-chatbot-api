import { MigrationInterface, QueryRunner } from 'typeorm';

export class SeedIndustryTemplateConfig1786423404737 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const salonConfig = {
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
    };

    const generalConfig = {
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
      `UPDATE "industry_templates" SET "config" = $1 WHERE "id" = 'salon'`,
      [salonConfig],
    );
    await queryRunner.query(
      `UPDATE "industry_templates" SET "config" = $1 WHERE "id" = 'general'`,
      [generalConfig],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "industry_templates" SET "config" = '{}' WHERE "id" IN ('salon', 'general')`,
    );
  }
}
