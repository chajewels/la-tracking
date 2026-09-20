import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { serviceTypeBadgeClass } from './service-badge-styles';
import { serviceJobHref } from './request-to-job';
import type { ServiceType } from './ServiceJobDialog';
import type { ServiceRequestRow } from './service-request-types';

/**
 * The job raised from a request, as one table cell — shared by the queue and
 * the account/order section so both read the same way.
 *
 * `stopPropagation` because the queue's rows are themselves buttons that open
 * the drawer: without it, following this link would also open the drawer
 * behind the navigation.
 */
export default function LinkedJobCell({ request }: { request: ServiceRequestRow }) {
  if (!request.service_job_id) {
    return <span className="text-muted-foreground">—</span>;
  }

  const job = request.service_jobs;
  return (
    <Link
      to={serviceJobHref(request.service_job_id)}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1.5 text-primary hover:underline"
      title={job ? `${job.service_type} · ${job.service_status}` : 'Open the service job'}
    >
      {job ? (
        <Badge variant="outline" className={serviceTypeBadgeClass(job.service_type as ServiceType)}>
          {job.service_type}
        </Badge>
      ) : (
        'Job'
      )}
    </Link>
  );
}
