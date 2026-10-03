package org.knime.agent;
import com.fasterxml.jackson.databind.JsonNode;
final class OperationPolicy {
    static String guardCoverage(String operation,JsonNode args){return "apply-time";}
}
