package org.knime.agent;
final class ContextAccess {
    static final class Conflict extends IllegalArgumentException {
        final String code;
        Conflict(String code,String message){super(message);this.code=code;}
    }
}
