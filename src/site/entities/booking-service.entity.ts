import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AutoMap } from '@automapper/classes';
import { Site } from './site.entity';

@Entity('booking_services')
export class BookingServiceItem {
  @AutoMap()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @AutoMap()
  @Column({ type: 'uuid' })
  siteId: string;

  @ManyToOne(() => Site, (site) => site.bookingServices, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'siteId' })
  site: Site;

  @AutoMap()
  @Column({ type: 'varchar', length: 255 })
  name: string;
}
